// Tests for the CSV importer that replaced Google Places scraping.
//
// Run: node --test client/src/csvImport.test.mjs
//
// This is the only way leads enter the system now, so a parser bug here is
// silent data loss on the one path that matters. The cases below are the ones
// a naive split(",") implementation gets wrong — and every real lead list has
// commas in the address field.
//
// parseCsv and rowsToLeads are imported from the page module. They are pure
// and dependency-free by design so they can be tested without a DOM.

import test from "node:test";
import assert from "node:assert/strict";

import { parseCsv, rowsToLeads } from "./csvImport.js";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseCsv keeps a quoted field containing a comma intact", () => {
  // The failure this prevents: "Miami, FL" splitting into two columns and
  // shifting every later field by one.
  const rows = parseCsv('business_name,location\nJoe Plumbing,"Miami, FL"');
  assert.deepEqual(rows[1], ["Joe Plumbing", "Miami, FL"]);
});

test("parseCsv handles an escaped double quote inside a quoted field", () => {
  const rows = parseCsv('business_name\n"Bob ""The Builder"" Inc"');
  assert.deepEqual(rows[1], ['Bob "The Builder" Inc']);
});

test("parseCsv handles a newline inside a quoted field", () => {
  // Excel writes multi-line notes exactly like this.
  const rows = parseCsv('business_name,notes\nAcme,"line one\nline two"');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["Acme", "line one\nline two"]);
});

test("parseCsv normalizes CRLF so no field keeps a trailing carriage return", () => {
  const rows = parseCsv("business_name,phone\r\nAcme,305-555-0100\r\n");
  assert.deepEqual(rows[1], ["Acme", "305-555-0100"]);
});

test("parseCsv handles a file with no trailing newline", () => {
  const rows = parseCsv("business_name\nAcme");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["Acme"]);
});

test("parseCsv preserves empty interior fields as empty strings", () => {
  // Position must be preserved: dropping the blank would shift `location`
  // into the `phone` column.
  const rows = parseCsv("business_name,phone,location\nAcme,,Miami");
  assert.deepEqual(rows[1], ["Acme", "", "Miami"]);
});

test("parseCsv skips blank lines without consuming a real row", () => {
  const rows = parseCsv("business_name\nAcme\n\n\nBeta\n");
  assert.deepEqual(rows.map((r) => r[0]), ["business_name", "Acme", "Beta"]);
});

// ---------------------------------------------------------------------------
// Mapping to leads
// ---------------------------------------------------------------------------

test("rowsToLeads rejects a file with no business_name column", () => {
  const out = rowsToLeads(parseCsv("name,phone\nAcme,305"));
  assert.equal(out.missingHeader, true);
  assert.equal(out.leads.length, 0);
});

test("rowsToLeads rejects an empty file rather than importing nothing silently", () => {
  const out = rowsToLeads(parseCsv(""));
  assert.equal(out.missingHeader, true);
});

test("rowsToLeads normalizes header case and spacing", () => {
  const out = rowsToLeads(parseCsv("Business Name,Phone\nAcme,305-555-0100"));
  assert.equal(out.missingHeader, false);
  assert.equal(out.leads[0].business_name, "Acme");
  assert.equal(out.leads[0].phone, "305-555-0100");
});

test("rowsToLeads reports unknown columns instead of dropping them silently", () => {
  // A typo'd header is otherwise invisible: the data just never arrives.
  const out = rowsToLeads(parseCsv("business_name,bussiness_phone\nAcme,305"));
  assert.deepEqual(out.unknownColumns, ["bussiness_phone"]);
});

test("rowsToLeads rejects rows with no business name and names the line", () => {
  const out = rowsToLeads(parseCsv("business_name,phone\nAcme,1\n,2\nBeta,3"));
  assert.equal(out.leads.length, 2);
  assert.equal(out.rejected.length, 1);
  // Line 3 of the file: header is line 1.
  assert.equal(out.rejected[0].line, 3);
});

test("rowsToLeads coerces numerics and never yields NaN", () => {
  // NaN would be rejected by Postgres and fail the entire batch insert, so a
  // single bad cell must not take the whole import down.
  const out = rowsToLeads(parseCsv("business_name,review_count,star_rating\nAcme,abc,xyz"));
  assert.equal(out.leads[0].review_count, 0);
  assert.equal(out.leads[0].star_rating, 0);
  assert.ok(Number.isFinite(out.leads[0].review_count));
  assert.ok(Number.isFinite(out.leads[0].star_rating));
});

test("rowsToLeads parses real numerics correctly", () => {
  const out = rowsToLeads(parseCsv("business_name,review_count,star_rating\nAcme,127,4.6"));
  assert.equal(out.leads[0].review_count, 127);
  assert.equal(out.leads[0].star_rating, 4.6);
});

test("rowsToLeads infers website_status when the column is absent", () => {
  const withSite = rowsToLeads(parseCsv("business_name,website_url\nAcme,https://acme.test"));
  assert.equal(withSite.leads[0].website_status, "Has Website");

  const withoutSite = rowsToLeads(parseCsv("business_name,website_url\nAcme,"));
  assert.equal(withoutSite.leads[0].website_status, "No Website");
});

test("rowsToLeads replaces an invalid website_status rather than passing it through", () => {
  // An unrecognized value would break score weighting, which keys off the
  // exact strings.
  const out = rowsToLeads(parseCsv("business_name,website_status\nAcme,maybe?"));
  assert.equal(out.leads[0].website_status, "No Website");
});

test("rowsToLeads keeps a valid website_status as given", () => {
  const out = rowsToLeads(parseCsv("business_name,website_status\nAcme,Outdated"));
  assert.equal(out.leads[0].website_status, "Outdated");
});

test("rowsToLeads trims surrounding whitespace from values", () => {
  const out = rowsToLeads(parseCsv("business_name,phone\n  Acme  ,  305-555-0100  "));
  assert.equal(out.leads[0].business_name, "Acme");
  assert.equal(out.leads[0].phone, "305-555-0100");
});

test("rowsToLeads handles a short row without throwing", () => {
  // A row with fewer cells than the header is common in hand-edited files.
  const out = rowsToLeads(parseCsv("business_name,phone,location\nAcme"));
  assert.equal(out.leads.length, 1);
  assert.equal(out.leads[0].phone, "");
  assert.equal(out.leads[0].location, "");
});

test("rowsToLeads end-to-end on a realistic file", () => {
  const csv =
    "business_name,owner_name,phone,email,location,industry,website_status,review_count,star_rating\n" +
    'Riverside Plumbing Co,Dana Ruiz,305-555-0101,dana@example.com,"Miami, FL",plumbers,No Website,48,4.6\n' +
    'Green Acre Lawn Care,,305-555-0102,,"Hialeah, FL",lawn care,Outdated,12,3.9\n';
  const out = rowsToLeads(parseCsv(csv));

  assert.equal(out.missingHeader, false);
  assert.deepEqual(out.unknownColumns, []);
  assert.deepEqual(out.rejected, []);
  assert.equal(out.leads.length, 2);
  assert.equal(out.leads[0].location, "Miami, FL");
  assert.equal(out.leads[0].star_rating, 4.6);
  assert.equal(out.leads[1].owner_name, "");
  assert.equal(out.leads[1].location, "Hialeah, FL");
});
