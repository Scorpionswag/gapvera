import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import db, { computeScore, scoreBreakdown, recomputeCallCounters } from "./db.js";
import { sendEmail, smtpConfigured } from "./mailer.js";
import { scrapeLeads, mapsConfigured } from "./scraper.js";
import { runAudit, findEmails } from "./auditor.js";
import { createAuth } from "./auth.js";
import { installAuth, isLoopbackHost } from "./authRoutes.js";

const app = express();
// Loopback origins only. This build is authorized for local operation; a
// browser page served from anywhere else must not be able to call the API.
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / non-browser caller
      try {
        return cb(null, isLoopbackHost(new URL(origin).host));
      } catch {
        return cb(null, false);
      }
    },
    credentials: true,
  })
);
app.use(express.json());

// ---------- Authentication ----------
// If the auth store cannot be initialized the server does not start. A CRM that
// silently comes up unprotected because a table was unreadable is the one
// failure mode worth refusing to boot over.
let auth;
try {
  auth = createAuth(db);
} catch (err) {
  console.error("FATAL: authentication store unavailable —", err.cause?.message || err.message);
  process.exit(1);
}

// Sessions are server-side only and do not survive a restart: whatever was
// handed out by the previous process is void.
auth.destroyAllSessions();
auth.prune();

const { requireAdmin } = installAuth(app, auth, {
  // Secure is mandatory under HTTPS; this increment is explicit HTTP loopback
  // only, where a Secure cookie would simply never be sent back.
  secureCookies: process.env.AUTH_SECURE_COOKIES === "true",
});

// THE GATE. Everything registered after this line requires a valid admin
// session, including routes added later — protection comes from position in the
// middleware chain, not from tagging each endpoint. The public auth endpoints
// are registered above it by installAuth().
app.use("/api", requireAdmin);

const LEAD_FIELDS = [
  "business_name", "owner_name", "phone", "email", "location", "industry",
  "website_status", "website_url", "outreach_status", "outreach_channel",
  "last_contact_date", "next_followup_date", "notes", "review_count",
  "star_rating", "audit_sent", "audit_notes", "calls_total", "calls_contacted",
  "calls_not_interested", "calls_voicemail", "calls_booked_demo", "lat", "lng",
];

// Auto follow-up sending is opt-in: you approve outreach by default.
const AUTO_FOLLOWUPS = process.env.AUTO_FOLLOWUPS === "true";

app.get("/api/config", (_req, res) =>
  res.json({ smtpConfigured, mapsConfigured, autoFollowups: AUTO_FOLLOWUPS })
);

// ---------- Leads ----------
app.get("/api/leads", (_req, res) => {
  res.json(db.prepare("SELECT * FROM leads ORDER BY lead_score DESC").all());
});

app.get("/api/leads/:id/score", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "not found" });
  res.json(scoreBreakdown(lead));
});

app.post("/api/leads", (req, res) => {
  const data = pick(req.body);
  data.lead_score = computeScore(data);
  const cols = Object.keys(data);
  const info = db
    .prepare(`INSERT INTO leads (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...Object.values(data));
  res.json(db.prepare("SELECT * FROM leads WHERE id = ?").get(info.lastInsertRowid));
});

// Dedupes on (business_name, location) so re-scraping a niche+city never
// creates duplicate leads.
app.post("/api/leads/bulk", (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  const existing = new Set(
    db.prepare("SELECT lower(business_name || '|' || location) AS k FROM leads").all().map((r) => r.k)
  );
  let imported = 0, skipped = 0;
  const insert = db.transaction((items) => {
    for (const item of items) {
      const key = `${item.business_name || ""}|${item.location || ""}`.toLowerCase();
      if (existing.has(key)) { skipped++; continue; }
      existing.add(key);
      const data = pick(item);
      data.lead_score = computeScore(data);
      const cols = Object.keys(data);
      db.prepare(`INSERT INTO leads (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
        .run(...Object.values(data));
      imported++;
    }
  });
  insert(rows);
  res.json({ imported, skipped });
});

// Run the technical website audit for a lead and store the report on it.
app.post("/api/leads/:id/run-audit", async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "not found" });
  if (!lead.website_url) return res.status(400).json({ error: "lead has no website URL" });
  const report = await runAudit(lead.website_url);
  db.prepare("UPDATE leads SET audit_report = ?, audit_date = ? WHERE id = ?")
    .run(JSON.stringify(report), report.scanned || report.fetched_at.slice(0, 10), lead.id);
  res.json(report);
});

// Harvest candidate emails from the lead's website. Returns candidates only;
// the user picks which one to save.
app.post("/api/leads/:id/find-email", async (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "not found" });
  if (!lead.website_url) return res.status(400).json({ error: "lead has no website URL" });
  res.json({ emails: await findEmails(lead.website_url) });
});

// Log a call as an event. Counters are recomputed from the log; decisive
// outcomes move the outreach status; an optional follow-up rides along so the
// whole post-call moment is one commit.
const CALL_OUTCOMES = ["contacted", "voicemail", "no_answer", "not_interested", "booked_demo"];

app.post("/api/leads/:id/call", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "not found" });
  const { outcome, note = "", followup_days = null } = req.body;
  if (!CALL_OUTCOMES.includes(outcome)) return res.status(400).json({ error: "bad outcome" });

  db.prepare("INSERT INTO calls (lead_id, outcome, note) VALUES (?, ?, ?)").run(lead.id, outcome, note);
  recomputeCallCounters(lead.id);

  let status = lead.outreach_status;
  if (outcome === "contacted" && status === "Not Contacted") status = "Contacted";
  if (outcome === "booked_demo" && status !== "Closed") status = "Booked";
  if (outcome === "not_interested" && status !== "Closed") status = "Not Interested";

  const today = new Date().toLocaleDateString("sv");
  const next = followup_days
    ? new Date(Date.now() + followup_days * 86400000).toLocaleDateString("sv")
    : lead.next_followup_date;
  db.prepare("UPDATE leads SET outreach_status = ?, last_contact_date = ?, next_followup_date = ? WHERE id = ?")
    .run(status, today, next || "", lead.id);
  res.json(db.prepare("SELECT * FROM leads WHERE id = ?").get(lead.id));
});

app.get("/api/leads/:id/calls", (req, res) => {
  res.json(
    db.prepare("SELECT * FROM calls WHERE lead_id = ? ORDER BY called_at DESC, id DESC LIMIT 20").all(req.params.id)
  );
});

// Deleting a log entry is the undo: aggregates recompute from what remains.
// Status is left alone; it may have legitimately moved on since.
app.delete("/api/calls/:id", (req, res) => {
  const call = db.prepare("SELECT * FROM calls WHERE id = ?").get(req.params.id);
  if (!call) return res.status(404).json({ error: "not found" });
  db.prepare("DELETE FROM calls WHERE id = ?").run(call.id);
  recomputeCallCounters(call.lead_id);
  res.json(db.prepare("SELECT * FROM leads WHERE id = ?").get(call.lead_id));
});

app.put("/api/leads/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const data = pick({ ...existing, ...req.body });
  data.lead_score = computeScore(data);
  db.prepare(
    `UPDATE leads SET ${Object.keys(data).map((c) => `${c} = ?`).join(", ")}, lead_score = ? WHERE id = ?`
  ).run(...Object.values(data), data.lead_score, req.params.id);
  res.json(db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id));
});

app.delete("/api/leads/:id", (req, res) => {
  // Detach email history first (FK) — sent emails stay in the global log.
  db.prepare("UPDATE email_logs SET lead_id = NULL WHERE lead_id = ?").run(req.params.id);
  db.prepare("DELETE FROM leads WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Convert to client, then mark the lead Closed.
app.post("/api/leads/:id/convert", (req, res) => {
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(req.params.id);
  if (!lead) return res.status(404).json({ error: "not found" });
  const c = req.body || {};
  const info = db
    .prepare(
      `INSERT INTO clients (lead_id, business_name, owner_name, phone, email, project_status,
       contract_value, deliverables, website_adjustments, start_date, due_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lead.id, lead.business_name, lead.owner_name, lead.phone, lead.email,
      c.project_status || "Discovery", c.contract_value || 0, c.deliverables || "",
      c.website_adjustments || "", c.start_date || "", c.due_date || "", c.notes || ""
    );
  db.prepare("UPDATE leads SET outreach_status = 'Closed' WHERE id = ?").run(lead.id);
  res.json(db.prepare("SELECT * FROM clients WHERE id = ?").get(info.lastInsertRowid));
});

// ---------- Clients ----------
app.get("/api/clients", (_req, res) =>
  res.json(db.prepare("SELECT * FROM clients ORDER BY created_at DESC").all())
);

app.put("/api/clients/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const allowed = [
    "business_name", "owner_name", "phone", "email", "project_status",
    "contract_value", "deliverables", "website_adjustments", "start_date", "due_date", "notes",
  ];
  const data = {};
  for (const k of allowed) data[k] = req.body[k] ?? existing[k];
  db.prepare(`UPDATE clients SET ${allowed.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .run(...allowed.map((k) => data[k]), req.params.id);
  res.json(db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id));
});

app.delete("/api/clients/:id", (req, res) => {
  // Remove the client's document files and rows along with the client.
  for (const doc of db.prepare("SELECT * FROM documents WHERE client_id = ?").all(req.params.id)) {
    try { fs.unlinkSync(docPath(doc)); } catch { /* file already gone */ }
  }
  db.prepare("DELETE FROM documents WHERE client_id = ?").run(req.params.id);
  try { fs.rmdirSync(path.join(FILES_DIR, String(req.params.id))); } catch { /* dir not empty or missing */ }
  db.prepare("DELETE FROM invoices WHERE client_id = ?").run(req.params.id);
  db.prepare("DELETE FROM clients WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Client documents ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILES_DIR = path.join(__dirname, "files", "clients");
fs.mkdirSync(FILES_DIR, { recursive: true });

const docPath = (doc) => path.join(FILES_DIR, String(doc.client_id), doc.stored_name);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(FILES_DIR, String(req.params.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 12);
      cb(null, `${crypto.randomBytes(8).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

app.post("/api/clients/:id/documents", upload.array("files", 10), (req, res) => {
  const client = db.prepare("SELECT id FROM clients WHERE id = ?").get(req.params.id);
  if (!client) return res.status(404).json({ error: "client not found" });
  const insert = db.prepare(
    "INSERT INTO documents (client_id, filename, stored_name, mime, size) VALUES (?, ?, ?, ?, ?)"
  );
  for (const f of req.files || []) {
    // Multer decodes originalname as latin1; recover UTF-8 names.
    const name = Buffer.from(f.originalname, "latin1").toString("utf8");
    insert.run(client.id, name, f.filename, f.mimetype, f.size);
  }
  res.json(db.prepare("SELECT * FROM documents WHERE client_id = ? ORDER BY uploaded_at DESC, id DESC").all(client.id));
});

app.get("/api/clients/:id/documents", (req, res) => {
  res.json(db.prepare("SELECT * FROM documents WHERE client_id = ? ORDER BY uploaded_at DESC, id DESC").all(req.params.id));
});

// ---------- Invoices ----------
const invoiceTotal = (inv) => {
  let items = [];
  try { items = JSON.parse(inv.line_items || "[]"); } catch { items = []; }
  const sub = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
  const tax = sub * ((Number(inv.tax_rate) || 0) / 100);
  return Math.round((sub + tax) * 100) / 100;
};

const withTotal = (inv) => ({ ...inv, total: invoiceTotal(inv) });

app.get("/api/invoices", (_req, res) => {
  res.json(
    db.prepare(
      `SELECT invoices.*, clients.business_name FROM invoices
       LEFT JOIN clients ON clients.id = invoices.client_id
       ORDER BY invoices.issue_date DESC, invoices.id DESC`
    ).all().map(withTotal)
  );
});

app.get("/api/clients/:id/invoices", (req, res) => {
  res.json(
    db.prepare("SELECT * FROM invoices WHERE client_id = ? ORDER BY issue_date DESC, id DESC")
      .all(req.params.id).map(withTotal)
  );
});

app.post("/api/clients/:id/invoices", (req, res) => {
  const client = db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
  if (!client) return res.status(404).json({ error: "client not found" });
  // Sequential number per year from the highest existing, so deletions can
  // never cause a duplicate: INV-2026-001, -002, ...
  const year = new Date().getFullYear();
  const numbers = db.prepare("SELECT number FROM invoices WHERE number LIKE ?").all(`INV-${year}-%`);
  const max = numbers.reduce((m, r) => Math.max(m, Number(r.number.split("-")[2]) || 0), 0);
  const number = `INV-${year}-${String(max + 1).padStart(3, "0")}`;
  const b = req.body || {};
  const info = db
    .prepare(
      `INSERT INTO invoices (client_id, number, status, issue_date, due_date, line_items, tax_rate, payment_instructions, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      client.id,
      number,
      b.status || "Draft",
      b.issue_date || new Date().toLocaleDateString("sv"),
      b.due_date || "",
      JSON.stringify(b.line_items || [{ description: client.deliverables || "Website design and build", qty: 1, rate: client.contract_value || 0 }]),
      b.tax_rate || 0,
      // Fallback chain: explicit → .env default → whatever the last invoice
      // used, so the payment block only ever has to be typed once.
      b.payment_instructions ||
        (process.env.INVOICE_PAYMENT_INSTRUCTIONS || "").replaceAll("\\n", "\n") ||
        db.prepare("SELECT payment_instructions FROM invoices WHERE payment_instructions != '' ORDER BY id DESC LIMIT 1").get()?.payment_instructions ||
        "",
      b.notes || ""
    );
  res.json(withTotal(db.prepare("SELECT * FROM invoices WHERE id = ?").get(info.lastInsertRowid)));
});

app.put("/api/invoices/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const allowed = ["status", "issue_date", "due_date", "tax_rate", "payment_instructions", "notes", "paid_date"];
  const data = {};
  for (const k of allowed) data[k] = req.body[k] ?? existing[k];
  data.line_items = req.body.line_items ? JSON.stringify(req.body.line_items) : existing.line_items;
  // Marking Paid stamps the date; un-paying clears it.
  if (data.status === "Paid" && !data.paid_date) data.paid_date = new Date().toLocaleDateString("sv");
  if (data.status !== "Paid") data.paid_date = "";
  const cols = Object.keys(data);
  db.prepare(`UPDATE invoices SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .run(...cols.map((k) => data[k]), req.params.id);
  res.json(withTotal(db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id)));
});

app.delete("/api/invoices/:id", (req, res) => {
  const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "not found" });
  // Only Drafts can be deleted. A sent invoice exists in the world with its
  // number on it — void it so the number is never reissued to someone else.
  if (inv.status !== "Draft" && inv.status !== "Void")
    return res.status(400).json({ error: "only Draft or Void invoices can be deleted; mark it Void instead" });
  db.prepare("DELETE FROM invoices WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/recent-documents", (_req, res) => {
  res.json(
    db.prepare(
      `SELECT documents.*, clients.business_name FROM documents
       LEFT JOIN clients ON clients.id = documents.client_id
       ORDER BY documents.uploaded_at DESC, documents.id DESC LIMIT 12`
    ).all()
  );
});

// Inline by default (browser views PDFs/images in a tab); ?download=1 forces
// a save with the original filename.
app.get("/api/documents/:id", (req, res) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
  if (!doc) return res.status(404).json({ error: "not found" });
  const file = docPath(doc);
  if (!fs.existsSync(file)) return res.status(410).json({ error: "file missing on disk" });
  if (req.query.download === "1") return res.download(file, doc.filename);
  res.setHeader("Content-Type", doc.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.filename)}"`);
  fs.createReadStream(file).pipe(res);
});

app.delete("/api/documents/:id", (req, res) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
  if (!doc) return res.status(404).json({ error: "not found" });
  try { fs.unlinkSync(docPath(doc)); } catch { /* already gone */ }
  db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
  res.json({ ok: true });
});

// ---------- Email templates ----------
app.get("/api/templates", (_req, res) =>
  res.json(db.prepare("SELECT * FROM email_templates ORDER BY id").all())
);

app.post("/api/templates", (req, res) => {
  const { name, kind, subject, body } = req.body;
  const info = db
    .prepare("INSERT INTO email_templates (name, kind, subject, body) VALUES (?, ?, ?, ?)")
    .run(name, kind || "initial", subject || "", body || "");
  res.json(db.prepare("SELECT * FROM email_templates WHERE id = ?").get(info.lastInsertRowid));
});

app.put("/api/templates/:id", (req, res) => {
  const { name, kind, subject, body } = req.body;
  db.prepare("UPDATE email_templates SET name = ?, kind = ?, subject = ?, body = ? WHERE id = ?")
    .run(name, kind, subject, body, req.params.id);
  res.json(db.prepare("SELECT * FROM email_templates WHERE id = ?").get(req.params.id));
});

app.delete("/api/templates/:id", (req, res) => {
  db.prepare("DELETE FROM email_templates WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Outreach ----------
app.post("/api/send-email", async (req, res) => {
  const { lead_id, template_id, subject, body } = req.body;
  const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(lead_id);
  if (!lead) return res.status(404).json({ error: "lead not found" });

  const result = await sendEmail({ lead, subject, body, templateId: template_id || null });

  const today = new Date().toISOString().slice(0, 10);
  const newStatus = lead.outreach_status === "Not Contacted" ? "Contacted" : lead.outreach_status;
  // Only auto-schedule a follow-up when the lead doesn't already have one —
  // a manually set date must never be clobbered by sending an email.
  const next = lead.next_followup_date && lead.outreach_status !== "Not Contacted"
    ? lead.next_followup_date
    : new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  db.prepare(
    "UPDATE leads SET outreach_status = ?, outreach_channel = 'Email', last_contact_date = ?, next_followup_date = ? WHERE id = ?"
  ).run(newStatus, today, next, lead.id);

  res.json(result);
});

app.get("/api/email-logs", (req, res) => {
  const { lead_id } = req.query;
  const rows = lead_id
    ? db.prepare("SELECT * FROM email_logs WHERE lead_id = ? ORDER BY sent_at DESC").all(lead_id)
    : db.prepare(
        `SELECT email_logs.*, leads.business_name FROM email_logs
         LEFT JOIN leads ON leads.id = email_logs.lead_id ORDER BY sent_at DESC LIMIT 200`
      ).all();
  res.json(rows);
});

// ---------- Scraping ----------
app.post("/api/scrape", async (req, res) => {
  const { niche, city } = req.body;
  if (!niche || !city) return res.status(400).json({ error: "niche and city required" });
  try {
    res.json(await scrapeLeads(niche, city));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Hourly follow-up automation ----------
// Leads due (or overdue) for follow-up get the matching follow-up template,
// picked by how far along outreach already is.
async function runScheduledFollowups(force = false) {
  // Without SMTP, "sending" would log mock emails nobody receives while still
  // advancing leads through the sequence — burning it silently. Never do that
  // on the schedule; only a manual force (for testing) may.
  if (!smtpConfigured && !force) {
    console.log("[followup] skipped — SMTP not configured; sequence preserved");
    return { skipped: true, reason: "smtp not configured" };
  }
  // You approve every send unless AUTO_FOLLOWUPS=true is set deliberately.
  if (!AUTO_FOLLOWUPS && !force) {
    console.log("[followup] skipped — auto-sending disabled (AUTO_FOLLOWUPS!=true)");
    return { skipped: true, reason: "auto-followups disabled" };
  }
  const today = new Date().toISOString().slice(0, 10);
  const due = db
    .prepare(
      `SELECT * FROM leads WHERE next_followup_date != '' AND next_followup_date <= ?
       AND outreach_status IN ('Contacted', 'Follow-Up 1') AND email != ''`
    )
    .all(today);

  for (const lead of due) {
    const kind = lead.outreach_status === "Contacted" ? "followup1" : "followup2";
    const template = db.prepare("SELECT * FROM email_templates WHERE kind = ? ORDER BY id LIMIT 1").get(kind);
    if (!template) continue;
    await sendEmail({
      lead,
      subject: template.subject,
      body: template.body,
      templateId: template.id,
      scheduledFor: today,
    });
    const nextStatus = kind === "followup1" ? "Follow-Up 1" : "Follow-Up 2";
    const next = kind === "followup1" ? new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10) : "";
    db.prepare(
      "UPDATE leads SET outreach_status = ?, last_contact_date = ?, next_followup_date = ? WHERE id = ?"
    ).run(nextStatus, today, next, lead.id);
    console.log(`[followup] ${kind} -> ${lead.business_name}`);
  }
  if (due.length) console.log(`[followup] processed ${due.length} lead(s)`);
  return { sent: due.length };
}

cron.schedule("0 * * * *", () => runScheduledFollowups());
app.post("/api/run-followups", async (req, res) => {
  res.json(await runScheduledFollowups(req.query.force === "true"));
});

function pick(body) {
  const data = {};
  for (const f of LEAD_FIELDS) if (body[f] !== undefined) data[f] = body[f];
  return data;
}

// API_PORT, not PORT: launch tooling injects PORT for the frontend and the
// API must never collide with Vite on it.
const PORT = process.env.API_PORT || 3001;
// Bound to loopback explicitly: remote exposure is out of scope for this
// increment, so the socket itself refuses to be reachable off-host rather than
// relying on the Host/Origin checks alone.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`CRM API on http://localhost:${PORT}`);
  console.log(`  Auth: single local admin — ${auth.adminExists() ? "configured" : "first-run setup required"}`);
  console.log(`  SMTP: ${smtpConfigured ? "configured" : "mock mode (emails logged, not sent)"}`);
  console.log(`  Google Maps: ${mapsConfigured ? "configured" : "mock mode (generated results)"}`);
});
