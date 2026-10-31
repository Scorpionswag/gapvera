import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "crm.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  owner_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  location TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  website_status TEXT DEFAULT 'No Website',
  website_url TEXT DEFAULT '',
  outreach_status TEXT DEFAULT 'Not Contacted',
  outreach_channel TEXT DEFAULT '',
  last_contact_date TEXT DEFAULT '',
  next_followup_date TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  review_count INTEGER DEFAULT 0,
  star_rating REAL DEFAULT 0,
  lead_score INTEGER DEFAULT 0,
  audit_sent INTEGER DEFAULT 0,
  audit_notes TEXT DEFAULT '',
  calls_total INTEGER DEFAULT 0,
  calls_contacted INTEGER DEFAULT 0,
  calls_not_interested INTEGER DEFAULT 0,
  calls_voicemail INTEGER DEFAULT 0,
  calls_booked_demo INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT DEFAULT 'initial',
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  template_id INTEGER,
  to_email TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  status TEXT DEFAULT 'sent',
  scheduled_for TEXT DEFAULT '',
  sent_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  business_name TEXT NOT NULL,
  owner_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  project_status TEXT DEFAULT 'Discovery',
  contract_value REAL DEFAULT 0,
  deliverables TEXT DEFAULT '',
  website_adjustments TEXT DEFAULT '',
  start_date TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// v0.0.0 migration: coordinates for the Territory map. Existing rows are
// backfilled from their city with a deterministic per-id jitter so the map has
// data immediately; real scrapes carry exact coordinates.
const CITY_COORDS = {
  miami: [25.7617, -80.1918],
  hialeah: [25.8576, -80.2781],
  "coral gables": [25.7215, -80.2684],
  kendall: [25.6793, -80.3173],
  homestead: [25.4687, -80.4776],
  doral: [25.8195, -80.3553],
};

export function cityCoords(location, seedNum = 0) {
  const key = Object.keys(CITY_COORDS).find((c) => (location || "").toLowerCase().includes(c));
  if (!key) return null;
  const [lat, lng] = CITY_COORDS[key];
  const j = (n) => ((((seedNum + 1) * 9301 + n * 49297) % 233280) / 233280 - 0.5) * 0.05;
  return { lat: lat + j(1), lng: lng + j(2) };
}

const leadCols = db.prepare("PRAGMA table_info(leads)").all().map((c) => c.name);
if (!leadCols.includes("lat")) {
  db.exec("ALTER TABLE leads ADD COLUMN lat REAL; ALTER TABLE leads ADD COLUMN lng REAL;");
}
if (!leadCols.includes("audit_report")) {
  db.exec("ALTER TABLE leads ADD COLUMN audit_report TEXT DEFAULT ''; ALTER TABLE leads ADD COLUMN audit_date TEXT DEFAULT '';");
}

// v0.2: calls are events, not counters. The lead's calls_* columns become
// derived aggregates recomputed from this log; legacy tallies are migrated in
// as backdated entries so nothing is lost.
db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  note TEXT DEFAULT '',
  called_at TEXT DEFAULT (datetime('now', 'localtime'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  uploaded_at TEXT DEFAULT (datetime('now', 'localtime'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  number TEXT NOT NULL,
  status TEXT DEFAULT 'Draft',
  issue_date TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  line_items TEXT DEFAULT '[]',
  tax_rate REAL DEFAULT 0,
  payment_instructions TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  paid_date TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);
`);

export function recomputeCallCounters(leadId) {
  const rows = db.prepare("SELECT outcome, COUNT(*) AS n FROM calls WHERE lead_id = ? GROUP BY outcome").all(leadId);
  const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, r.n]));
  const total = rows.reduce((s, r) => s + r.n, 0);
  db.prepare(
    `UPDATE leads SET calls_total = ?, calls_contacted = ?, calls_voicemail = ?,
     calls_not_interested = ?, calls_booked_demo = ? WHERE id = ?`
  ).run(
    total,
    byOutcome.contacted || 0,
    byOutcome.voicemail || 0,
    byOutcome.not_interested || 0,
    byOutcome.booked_demo || 0,
    leadId
  );
}

// One-time migration of pre-log counters into backdated log entries.
const hasCalls = db.prepare("SELECT COUNT(*) AS n FROM calls").get().n;
if (hasCalls === 0) {
  const legacy = db.prepare("SELECT * FROM leads WHERE calls_total > 0").all();
  const insert = db.prepare("INSERT INTO calls (lead_id, outcome, note, called_at) VALUES (?, ?, ?, ?)");
  for (const lead of legacy) {
    const when = (lead.last_contact_date || lead.created_at || "").slice(0, 10) + " 12:00:00";
    const outcomes = {
      contacted: lead.calls_contacted,
      voicemail: lead.calls_voicemail,
      not_interested: lead.calls_not_interested,
      booked_demo: lead.calls_booked_demo,
    };
    let accounted = 0;
    for (const [outcome, n] of Object.entries(outcomes)) {
      for (let i = 0; i < n; i++) insert.run(lead.id, outcome, "(migrated tally)", when);
      accounted += n;
    }
    for (let i = 0; i < lead.calls_total - accounted; i++) insert.run(lead.id, "no_answer", "(migrated tally)", when);
    recomputeCallCounters(lead.id);
  }
}
for (const row of db.prepare("SELECT id, location FROM leads WHERE lat IS NULL").all()) {
  const c = cityCoords(row.location, row.id);
  if (c) db.prepare("UPDATE leads SET lat = ?, lng = ? WHERE id = ?").run(c.lat, c.lng, row.id);
}

// Lead score: no website is the biggest opportunity signal, then reviews/rating
// (proof the business is real and busy), then reachability.
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

export function scoreBreakdown(lead) {
  const rating = Number(lead.star_rating) || 0;
  const reviews = Number(lead.review_count) || 0;
  return [
    {
      label: "Website opportunity",
      max: 40,
      points:
        lead.website_status === "No Website"
          ? 40
          : lead.website_status === "Outdated"
          ? 25
          : 5,
      detail: lead.website_status,
    },
    {
      label: "Star rating",
      max: 20,
      points: Math.round((Math.min(rating, 5) / 5) * 20),
      detail: `${rating} stars`,
    },
    {
      label: "Review count",
      max: 20,
      points: Math.min(20, Math.round(reviews / 5)),
      detail: `${reviews} reviews`,
    },
    { label: "Email on file", max: 10, points: lead.email ? 10 : 0, detail: lead.email || "none" },
    { label: "Phone on file", max: 10, points: lead.phone ? 10 : 0, detail: lead.phone || "none" },
  ];
}

export default db;
