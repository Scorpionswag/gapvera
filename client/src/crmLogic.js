// Business rules that used to live in the Express server. With the server gone,
// these run in the browser against Supabase. They are pure functions here so
// they can be unit tested without a network or a database.
//
// These are ports, not rewrites: the scoring weights, call-outcome transitions,
// invoice numbering, and totals must produce the same results as
// server/db.js and server/index.js did, or migrated data stops agreeing with
// the values already stored in it.

export const LEAD_FIELDS = [
  "business_name", "owner_name", "phone", "email", "location", "industry",
  "website_status", "website_url", "outreach_status", "outreach_channel",
  "last_contact_date", "next_followup_date", "notes", "review_count",
  "star_rating", "audit_sent", "audit_notes", "calls_total", "calls_contacted",
  "calls_not_interested", "calls_voicemail", "calls_booked_demo", "lat", "lng",
];

export const CALL_OUTCOMES = ["contacted", "voicemail", "no_answer", "not_interested", "booked_demo"];

// Keep only known lead columns. PostgREST rejects an unknown key with a 400,
// so a page that passes a derived field (like `total`) back into an update
// would otherwise fail the whole write.
export function pickLeadFields(body) {
  const data = {};
  for (const f of LEAD_FIELDS) if (body[f] !== undefined) data[f] = body[f];
  return data;
}

// Port of server/db.js computeScore. No website is the biggest opportunity
// signal, then reviews/rating, then reachability.
export function computeScore(lead) {
  let score = 0;
  if (lead.website_status === "No Website") score += 40;
  else if (lead.website_status === "Outdated") score += 25;
  else score += 5;

  const rating = Number(lead.star_rating) || 0;
  score += Math.round((Math.min(rating, 5) / 5) * 20);

  const reviews = Number(lead.review_count) || 0;
  score += Math.min(20, Math.round(reviews / 5));

  if (lead.email) score += 10;
  if (lead.phone) score += 10;
  return Math.min(100, score);
}

// Port of server/db.js scoreBreakdown.
export function scoreBreakdown(lead) {
  const rating = Number(lead.star_rating) || 0;
  const reviews = Number(lead.review_count) || 0;
  return [
    {
      label: "Website opportunity",
      max: 40,
      points:
        lead.website_status === "No Website" ? 40 : lead.website_status === "Outdated" ? 25 : 5,
      detail: lead.website_status,
    },
    { label: "Star rating", max: 20, points: Math.round((Math.min(rating, 5) / 5) * 20), detail: `${rating} stars` },
    { label: "Review count", max: 20, points: Math.min(20, Math.round(reviews / 5)), detail: `${reviews} reviews` },
    { label: "Email on file", max: 10, points: lead.email ? 10 : 0, detail: lead.email || "none" },
    { label: "Phone on file", max: 10, points: lead.phone ? 10 : 0, detail: lead.phone || "none" },
  ];
}

// Dedupe key for bulk import: same business at the same location is the same
// lead, so re-importing a CSV never creates duplicates.
export function dedupeKey(row) {
  return `${row.business_name || ""}|${row.location || ""}`.toLowerCase();
}

// Port of the counter recomputation in server/db.js. Counters are derived from
// the call log, never incremented in place — so deleting a logged call is a
// true undo.
export function callCountersFrom(calls) {
  const by = (outcome) => calls.filter((c) => c.outcome === outcome).length;
  return {
    calls_total: calls.length,
    calls_contacted: by("contacted"),
    calls_voicemail: by("voicemail"),
    calls_not_interested: by("not_interested"),
    calls_booked_demo: by("booked_demo"),
  };
}

// Port of the status transitions in the POST /api/leads/:id/call handler.
// Closed is terminal: a late voicemail must not drag a closed deal backwards.
export function statusAfterCall(currentStatus, outcome) {
  if (outcome === "contacted" && currentStatus === "Not Contacted") return "Contacted";
  if (outcome === "booked_demo" && currentStatus !== "Closed") return "Booked";
  if (outcome === "not_interested" && currentStatus !== "Closed") return "Not Interested";
  return currentStatus;
}

// Local calendar date as YYYY-MM-DD. The "sv" locale is ISO-shaped, which is
// what the original server used; going through toISOString() instead would
// shift the date for anyone west of UTC after 7pm.
export function today() {
  return new Date().toLocaleDateString("sv");
}

export function daysFromToday(n) {
  return new Date(Date.now() + n * 86400000).toLocaleDateString("sv");
}

// Port of invoiceTotal in server/index.js. Rounded to cents at the end so a
// tax rate like 7% on an odd subtotal doesn't display a float artifact.
export function invoiceTotal(inv) {
  let items = [];
  try {
    items = typeof inv.line_items === "string" ? JSON.parse(inv.line_items || "[]") : inv.line_items || [];
  } catch {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  const sub = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
  const tax = sub * ((Number(inv.tax_rate) || 0) / 100);
  return Math.round((sub + tax) * 100) / 100;
}

export const withTotal = (inv) => ({ ...inv, total: invoiceTotal(inv) });

// Port of the numbering in POST /api/clients/:id/invoices: sequential per year
// from the highest existing number, so deleting a draft can never cause the
// next invoice to reuse a number that was already issued to someone.
export function nextInvoiceNumber(existingNumbers, year = new Date().getFullYear()) {
  const prefix = `INV-${year}-`;
  const max = existingNumbers
    .filter((n) => typeof n === "string" && n.startsWith(prefix))
    .reduce((m, n) => Math.max(m, Number(n.split("-")[2]) || 0), 0);
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

// Only a Draft or an already-Void invoice may be deleted. A sent invoice exists
// in the world with its number on it; voiding keeps the number burned so it is
// never reissued.
export function canDeleteInvoice(invoice) {
  return invoice.status === "Draft" || invoice.status === "Void";
}

// Random object name for Storage. The original filename is kept in the
// documents row; the stored name is opaque so an uploaded name can never
// traverse a path or collide.
export function storedName(filename) {
  const ext = (filename.match(/\.[A-Za-z0-9]{1,12}$/) || [""])[0];
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}${ext}`;
}

export const objectPathFor = (doc) => `${doc.client_id}/${doc.stored_name}`;
