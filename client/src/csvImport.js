// CSV import for leads. Extracted from the Scrape page so it can be unit
// tested without a DOM — this is the only path leads enter the system by now
// that Google Places scraping is disabled, so a silent bug here is lost
// prospects.

import { WEBSITE_STATUSES } from "./api.js";

// Columns the importer understands. business_name is the only required one;
// everything else is optional and defaults the same way a hand-entered lead
// does.
export const KNOWN_COLUMNS = [
  "business_name", "owner_name", "phone", "email", "location", "industry",
  "website_status", "website_url", "notes", "review_count", "star_rating",
];

export const TEMPLATE_CSV =
  "business_name,owner_name,phone,email,location,industry,website_status,website_url,review_count,star_rating,notes\n" +
  "Riverside Plumbing Co,Dana Ruiz,305-555-0101,dana@example.com,\"Miami, FL\",plumbers,No Website,,48,4.6,Met at trade show\n";

/**
 * RFC4180-style CSV parser: handles quoted fields, embedded commas, embedded
 * newlines, and escaped double quotes. A split(",") would corrupt any address
 * field containing a comma, which is most of them.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  // Normalize line endings so a Windows-exported file doesn't leave \r stuck
  // on the end of every last column.
  const src = text.replace(/\r\n?/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Flush the final field/row when the file doesn't end in a newline.
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Maps parsed CSV rows onto lead objects. Returns both the usable rows and the
 * rejected ones with a reason, so the UI can show exactly what was skipped
 * rather than a count that hides the detail.
 */
export function rowsToLeads(parsed) {
  if (!parsed.length) return { leads: [], rejected: [], unknownColumns: [], missingHeader: true };

  const header = parsed[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  if (!header.includes("business_name")) {
    return { leads: [], rejected: [], unknownColumns: [], missingHeader: true };
  }

  // Report columns we're ignoring instead of dropping them silently — a typo'd
  // header is otherwise invisible and the data just never arrives.
  const unknownColumns = header.filter((h) => h && !KNOWN_COLUMNS.includes(h));

  const leads = [];
  const rejected = [];

  parsed.slice(1).forEach((cells, idx) => {
    const row = {};
    header.forEach((col, i) => {
      if (KNOWN_COLUMNS.includes(col)) row[col] = (cells[i] ?? "").trim();
    });

    if (!row.business_name) {
      rejected.push({ line: idx + 2, reason: "no business_name" });
      return;
    }

    // Numeric coercion is explicit: a non-numeric rating becomes 0 rather than
    // NaN, which Postgres would reject and which would fail the whole batch.
    row.review_count = Number.parseInt(row.review_count, 10) || 0;
    row.star_rating = Number.parseFloat(row.star_rating) || 0;

    // An unrecognized website_status would break the score weighting, which
    // keys off these exact strings, so it is normalized to the safest
    // assumption rather than passed through.
    if (!WEBSITE_STATUSES.includes(row.website_status)) {
      row.website_status = row.website_url ? "Has Website" : "No Website";
    }

    leads.push(row);
  });

  return { leads, rejected, unknownColumns, missingHeader: false };
}
