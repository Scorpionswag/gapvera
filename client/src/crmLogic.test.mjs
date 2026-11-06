// Tests for the business rules that moved from the Express server into the
// browser during the Supabase migration.
//
// Run: node --test client/src/crmLogic.test.mjs
//
// These matter because the logic was ported, not rewritten: the migrated
// database already contains lead_score values, invoice numbers, and call
// counters computed by the old server. If any of these functions disagrees
// with its Express ancestor, the hosted app starts silently rewriting stored
// values the moment a record is edited.

import test from "node:test";
import assert from "node:assert/strict";

import {
  callCountersFrom,
  canDeleteInvoice,
  computeScore,
  dedupeKey,
  invoiceTotal,
  nextInvoiceNumber,
  objectPathFor,
  pickLeadFields,
  scoreBreakdown,
  statusAfterCall,
} from "./crmLogic.js";

// ---------------------------------------------------------------------------
// Lead scoring — must match server/db.js computeScore exactly
// ---------------------------------------------------------------------------

test("computeScore: no website is worth more than an outdated one", () => {
  const base = { star_rating: 0, review_count: 0, email: "", phone: "" };
  assert.equal(computeScore({ ...base, website_status: "No Website" }), 40);
  assert.equal(computeScore({ ...base, website_status: "Outdated" }), 25);
  assert.equal(computeScore({ ...base, website_status: "Has Website" }), 5);
});

test("computeScore: reproduces the stored score for a real migrated lead", () => {
  // Riverside Plumbing Co, exactly as it exists in the migrated database.
  // Its stored lead_score is 99, computed by the old Express server. If the
  // ported function disagrees, the hosted app silently rewrites the score the
  // first time anyone edits this lead.
  const lead = {
    website_status: "No Website",
    star_rating: 4.8,
    review_count: 127,
    email: "owner@example.com",
    phone: "(305) 555-0142",
  };
  // 40 (no site) + 19 (round(4.8/5*20)) + 20 (review cap) + 10 + 10 = 99
  assert.equal(computeScore(lead), 99);
});

test("computeScore: caps at 100 even when every signal maxes out", () => {
  assert.equal(
    computeScore({
      website_status: "No Website",
      star_rating: 5,
      review_count: 10000,
      email: "a@b.c",
      phone: "1",
    }),
    100
  );
});

test("computeScore: a rating above 5 cannot inflate the score", () => {
  // Bad import data must not produce a score the UI can't explain.
  const inflated = computeScore({ website_status: "No Website", star_rating: 50, review_count: 0 });
  const legitimate = computeScore({ website_status: "No Website", star_rating: 5, review_count: 0 });
  assert.equal(inflated, legitimate);
});

test("computeScore: non-numeric rating and reviews degrade to zero, not NaN", () => {
  const score = computeScore({
    website_status: "Has Website",
    star_rating: "not a number",
    review_count: undefined,
  });
  assert.equal(score, 5);
  assert.ok(Number.isFinite(score));
});

test("scoreBreakdown: points sum to computeScore for the same lead", () => {
  const lead = {
    website_status: "Outdated",
    star_rating: 3.2,
    review_count: 61,
    email: "x@y.z",
    phone: "",
  };
  const total = scoreBreakdown(lead).reduce((s, part) => s + part.points, 0);
  assert.equal(total, computeScore(lead));
});

// ---------------------------------------------------------------------------
// Field whitelisting
// ---------------------------------------------------------------------------

test("pickLeadFields drops unknown keys that PostgREST would reject", () => {
  const picked = pickLeadFields({
    business_name: "Acme",
    // `total` and `business_name` from an embedded join are the realistic
    // offenders: they ride along in a row the UI already holds.
    total: 123,
    clients: { business_name: "nope" },
    id: 7,
    lead_score: 99,
  });
  assert.deepEqual(Object.keys(picked), ["business_name"]);
});

test("pickLeadFields keeps falsy values that are real edits", () => {
  // Clearing a phone number is "" and must survive; it is not the same as
  // "field not supplied".
  const picked = pickLeadFields({ phone: "", lat: 0, review_count: 0 });
  assert.deepEqual(picked, { phone: "", review_count: 0, lat: 0 });
});

// ---------------------------------------------------------------------------
// Call log → counters and status
// ---------------------------------------------------------------------------

test("callCountersFrom derives every counter from the log", () => {
  const calls = [
    { outcome: "contacted" }, { outcome: "contacted" }, { outcome: "voicemail" },
    { outcome: "no_answer" }, { outcome: "booked_demo" }, { outcome: "not_interested" },
  ];
  assert.deepEqual(callCountersFrom(calls), {
    calls_total: 6,
    calls_contacted: 2,
    calls_voicemail: 1,
    calls_not_interested: 1,
    calls_booked_demo: 1,
  });
});

test("callCountersFrom on an empty log zeroes the counters", () => {
  // This is the undo path: deleting the last call must clear the tallies
  // rather than leaving the old numbers stranded on the lead.
  assert.deepEqual(callCountersFrom([]), {
    calls_total: 0,
    calls_contacted: 0,
    calls_voicemail: 0,
    calls_not_interested: 0,
    calls_booked_demo: 0,
  });
});

test("statusAfterCall: Closed is terminal", () => {
  // A late voicemail or a stray "not interested" must never drag a closed
  // deal backwards out of Closed.
  for (const outcome of ["contacted", "voicemail", "no_answer", "not_interested", "booked_demo"]) {
    assert.equal(statusAfterCall("Closed", outcome), "Closed");
  }
});

test("statusAfterCall: first contact advances only from Not Contacted", () => {
  assert.equal(statusAfterCall("Not Contacted", "contacted"), "Contacted");
  // Already further along — a call must not rewind the sequence to Contacted.
  assert.equal(statusAfterCall("Follow-Up 2", "contacted"), "Follow-Up 2");
  assert.equal(statusAfterCall("Interested", "contacted"), "Interested");
});

test("statusAfterCall: decisive outcomes override mid-sequence states", () => {
  assert.equal(statusAfterCall("Follow-Up 1", "booked_demo"), "Booked");
  assert.equal(statusAfterCall("Follow-Up 1", "not_interested"), "Not Interested");
});

test("statusAfterCall: no_answer and voicemail never change status", () => {
  assert.equal(statusAfterCall("Not Contacted", "no_answer"), "Not Contacted");
  assert.equal(statusAfterCall("Not Contacted", "voicemail"), "Not Contacted");
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

test("dedupeKey is case-insensitive on name and location", () => {
  assert.equal(
    dedupeKey({ business_name: "Riverside Plumbing", location: "Miami, FL" }),
    dedupeKey({ business_name: "RIVERSIDE PLUMBING", location: "miami, fl" })
  );
});

test("dedupeKey separates the same business in two cities", () => {
  assert.notEqual(
    dedupeKey({ business_name: "Joe's Pizza", location: "Miami, FL" }),
    dedupeKey({ business_name: "Joe's Pizza", location: "Doral, FL" })
  );
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

test("invoiceTotal applies tax to the line-item subtotal", () => {
  const inv = { line_items: JSON.stringify([{ qty: 2, rate: 500 }, { qty: 1, rate: 250 }]), tax_rate: 7 };
  // 1250 + 7% = 1337.5
  assert.equal(invoiceTotal(inv), 1337.5);
});

test("invoiceTotal rounds to cents rather than exposing float error", () => {
  const inv = { line_items: JSON.stringify([{ qty: 3, rate: 33.33 }]), tax_rate: 8.25 };
  const total = invoiceTotal(inv);
  // 99.99 * 1.0825 = 108.2391675 — must land on a clean 2-decimal value
  // rather than carrying the float tail into the UI.
  assert.equal(total, Math.round(total * 100) / 100);
  assert.equal(total, 108.24);
});

test("invoiceTotal accepts line_items as an array as well as a JSON string", () => {
  // PostgREST hands back whatever was stored; the UI may hold the parsed form.
  const asArray = invoiceTotal({ line_items: [{ qty: 1, rate: 100 }], tax_rate: 0 });
  const asString = invoiceTotal({ line_items: '[{"qty":1,"rate":100}]', tax_rate: 0 });
  assert.equal(asArray, 100);
  assert.equal(asString, 100);
});

test("invoiceTotal treats malformed line_items as empty instead of throwing", () => {
  // A corrupt cell must render as $0, not crash the whole Ledger page.
  assert.equal(invoiceTotal({ line_items: "{not json", tax_rate: 10 }), 0);
  assert.equal(invoiceTotal({ line_items: null, tax_rate: 10 }), 0);
  assert.equal(invoiceTotal({ line_items: '"a string"', tax_rate: 10 }), 0);
});

test("invoiceTotal ignores non-numeric qty and rate", () => {
  const inv = { line_items: JSON.stringify([{ qty: "two", rate: "free" }, { qty: 1, rate: 50 }]), tax_rate: 0 };
  assert.equal(invoiceTotal(inv), 50);
});

test("nextInvoiceNumber continues from the highest existing number", () => {
  assert.equal(nextInvoiceNumber(["INV-2026-001", "INV-2026-002"], 2026), "INV-2026-003");
});

test("nextInvoiceNumber never reissues a number after a deletion", () => {
  // 002 was deleted. Reusing it would put two different invoices into the
  // world under one number, which is the failure this guards.
  assert.equal(nextInvoiceNumber(["INV-2026-001", "INV-2026-003"], 2026), "INV-2026-004");
});

test("nextInvoiceNumber starts a fresh sequence in a new year", () => {
  assert.equal(nextInvoiceNumber(["INV-2026-007"], 2027), "INV-2027-001");
});

test("nextInvoiceNumber ignores other years and malformed numbers", () => {
  assert.equal(
    nextInvoiceNumber(["INV-2025-099", "INV-2026-004", "", null, "GARBAGE", "INV-2026-xyz"], 2026),
    "INV-2026-005"
  );
});

test("nextInvoiceNumber pads to three digits", () => {
  assert.equal(nextInvoiceNumber([], 2026), "INV-2026-001");
  assert.equal(nextInvoiceNumber(["INV-2026-009"], 2026), "INV-2026-010");
  assert.equal(nextInvoiceNumber(["INV-2026-099"], 2026), "INV-2026-100");
});

test("canDeleteInvoice protects anything that was issued", () => {
  assert.equal(canDeleteInvoice({ status: "Draft" }), true);
  assert.equal(canDeleteInvoice({ status: "Void" }), true);
  // A Sent or Paid invoice exists in the world with its number on it.
  assert.equal(canDeleteInvoice({ status: "Sent" }), false);
  assert.equal(canDeleteInvoice({ status: "Paid" }), false);
});

// ---------------------------------------------------------------------------
// Storage object paths
// ---------------------------------------------------------------------------

test("objectPathFor scopes a document under its client", () => {
  // The storage policy keys access off the leading folder, so this prefix is
  // load-bearing, not cosmetic.
  assert.equal(objectPathFor({ client_id: 12, stored_name: "a1b2.pdf" }), "12/a1b2.pdf");
});
