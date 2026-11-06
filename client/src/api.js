// The data layer. Every call in here goes to Supabase directly from the
// browser; there is no GapVera server any more.
//
// The exported shape (`api`, `auth`, the status constants, the template
// helpers) is deliberately identical to the Express-backed version so the
// pages did not have to be rewritten alongside the backend. Two deliberate
// breaks from the old contract:
//
//   1. `api.docUrl` is async. Documents live in a private bucket, so a URL has
//      to be minted per request instead of being a static path (acceptance 6).
//   2. Scraping, SMTP sending, website audit, and email discovery throw
//      FeatureUnavailable instead of returning a result. They are not
//      available in the zero-cost build and must not pretend otherwise
//      (acceptance 11).

import {
  isConfigured,
  supaAuth,
  db,
  storage,
  currentUser,
  hasSession,
  AUTH_LOST_EVENT,
} from "./supabase.js";
import {
  CALL_OUTCOMES,
  callCountersFrom,
  canDeleteInvoice,
  computeScore,
  daysFromToday,
  dedupeKey,
  invoiceTotal,
  nextInvoiceNumber,
  objectPathFor,
  pickLeadFields,
  scoreBreakdown,
  statusAfterCall,
  storedName,
  today,
  withTotal,
} from "./crmLogic.js";

export { AUTH_LOST_EVENT, isConfigured };

// A disabled capability has its own error type so the UI can render it as a
// explanation of what to do instead, not as a failure that might work on retry.
export class FeatureUnavailable extends Error {
  constructor(feature, reason, alternative) {
    super(reason);
    this.name = "FeatureUnavailable";
    this.feature = feature;
    this.alternative = alternative;
    this.unavailable = true;
  }
}

// Capabilities the zero-cost build does not have, with the honest reason and
// the manual path that replaces each. The UI reads these so the explanation
// lives in exactly one place.
export const UNAVAILABLE = {
  scrape: {
    feature: "Google Places lead scraping",
    reason:
      "Lead scraping is turned off in this build. The Google Places API requires a billed Google Cloud account, which this deployment deliberately does not have.",
    alternative: "Add leads by hand, or import a CSV on the Leads page.",
  },
  sendEmail: {
    feature: "Automated email sending",
    reason:
      "GapVera cannot send email in this build. There is no SMTP provider configured, and no free tier was accepted for one.",
    alternative:
      "Save the message as a draft here, then copy it into your own email client to send. Drafts are kept with the lead.",
  },
  audit: {
    feature: "Automated website audit",
    reason:
      "The audit has to load the prospect's website and read its HTML. A browser cannot do that for another domain — the request is blocked by the same-origin policy — and the server that used to do it has been removed.",
    alternative: "Open the site yourself and record what you find in the lead's notes.",
  },
  findEmail: {
    feature: "Email discovery",
    reason:
      "Finding an address means fetching and scanning the prospect's site, which a browser is not allowed to do across domains.",
    alternative: "Check the site's contact page yourself and paste the address into the lead.",
  },
};

const unavailable = (key) => {
  const u = UNAVAILABLE[key];
  throw new FeatureUnavailable(u.feature, u.reason, u.alternative);
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const auth = {
  // Shaped like the old /api/auth/status response so App.jsx's state machine
  // did not need restructuring. setupRequired is permanently false: accounts
  // are created in the Supabase dashboard, never from this app.
  async status() {
    if (!isConfigured) throw new Error("Supabase is not configured for this build.");
    if (!hasSession()) return { authenticated: false, setupRequired: false };
    const result = await supaAuth.verify();
    return {
      authenticated: Boolean(result.authenticated && result.isOwner),
      // Signed in but not the owner is its own state: the credentials were
      // right, the authorization is missing. Saying "wrong password" would
      // send the operator chasing the wrong problem.
      authenticatedNotOwner: Boolean(result.authenticated && !result.isOwner),
      setupRequired: false,
      user: result.user || null,
    };
  },

  async login(email, password) {
    await supaAuth.signIn(email, password);
    const result = await supaAuth.verify();
    if (!result.authenticated) throw new Error("Sign in did not produce a usable session.");
    if (!result.isOwner) {
      // Do not leave a live token sitting in storage for an account that is
      // not allowed in.
      await supaAuth.signOut();
      throw new Error("This account is not authorized for GapVera.");
    }
    return { authenticated: true, user: result.user };
  },

  logout: () => supaAuth.signOut(),
  user: currentUser,
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const api = {
  // No server to ask, so capabilities are reported from the build itself.
  config: async () => ({
    smtpConfigured: false,
    mapsConfigured: false,
    autoFollowups: false,
    scrapeAvailable: false,
    backend: "supabase",
  }),

  // ---------- Leads ----------
  leads: () => db.select("leads", "order=lead_score.desc"),

  scoreBreakdown: async (id) => {
    const rows = await db.select("leads", `id=eq.${id}`);
    if (!rows.length) throw new Error("not found");
    return scoreBreakdown(rows[0]);
  },

  createLead: (data) => {
    const row = pickLeadFields(data);
    row.lead_score = computeScore(row);
    return db.insert("leads", row);
  },

  // Dedupes against what is already stored, and within the batch itself, so
  // importing the same CSV twice is a no-op rather than a duplicate set.
  bulkImport: async (rows) => {
    const incoming = Array.isArray(rows) ? rows : [];
    if (!incoming.length) return { imported: 0, skipped: 0 };

    const existingRows = await db.select("leads", "select=business_name,location");
    const seen = new Set(existingRows.map(dedupeKey));

    const toInsert = [];
    let skipped = 0;
    for (const item of incoming) {
      const key = dedupeKey(item);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      const row = pickLeadFields(item);
      row.lead_score = computeScore(row);
      toInsert.push(row);
    }
    // One request for the whole batch: PostgREST inserts it as a single
    // statement, so a failure part-way cannot leave half a CSV imported.
    if (toInsert.length) await db.insert("leads", toInsert);
    return { imported: toInsert.length, skipped };
  },

  updateLead: async (id, data) => {
    const rows = await db.select("leads", `id=eq.${id}`);
    if (!rows.length) throw new Error("not found");
    // Score is recomputed from the merged row, so editing only the phone
    // number still updates the score that depends on it.
    const merged = pickLeadFields({ ...rows[0], ...data });
    merged.lead_score = computeScore(merged);
    return db.update("leads", id, merged);
  },

  deleteLead: async (id) => {
    // Detach email history first. The log is a record of what was composed and
    // outlives the lead; the FK would otherwise block the delete.
    await db.raw(`/email_logs?lead_id=eq.${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: null }),
    });
    return db.remove("leads", id);
  },

  convertLead: async (id, data = {}) => {
    const rows = await db.select("leads", `id=eq.${id}`);
    if (!rows.length) throw new Error("not found");
    const lead = rows[0];
    const client = await db.insert("clients", {
      lead_id: lead.id,
      business_name: lead.business_name,
      owner_name: lead.owner_name,
      phone: lead.phone,
      email: lead.email,
      project_status: data.project_status || "Discovery",
      contract_value: data.contract_value || 0,
      deliverables: data.deliverables || "",
      website_adjustments: data.website_adjustments || "",
      start_date: data.start_date || "",
      due_date: data.due_date || "",
      notes: data.notes || "",
    });
    // Only after the client row exists — if the insert above failed, the lead
    // must not be left marked Closed with nothing to show for it.
    await db.update("leads", lead.id, { outreach_status: "Closed" });
    return client;
  },

  // ---------- Calls ----------
  logCall: async (id, outcome, note = "", followupDays = null) => {
    if (!CALL_OUTCOMES.includes(outcome)) throw new Error("bad outcome");
    const rows = await db.select("leads", `id=eq.${id}`);
    if (!rows.length) throw new Error("not found");
    const lead = rows[0];

    await db.insert("calls", { lead_id: lead.id, outcome, note });

    // Recompute counters from the log rather than incrementing, so the stored
    // aggregate can never drift from the events behind it.
    const calls = await db.select("calls", `lead_id=eq.${lead.id}`);
    const next = followupDays ? daysFromToday(followupDays) : lead.next_followup_date;
    return db.update("leads", lead.id, {
      ...callCountersFrom(calls),
      outreach_status: statusAfterCall(lead.outreach_status, outcome),
      last_contact_date: today(),
      next_followup_date: next || "",
    });
  },

  leadCalls: (id) => db.select("calls", `lead_id=eq.${id}&order=called_at.desc,id.desc&limit=20`),

  // Deleting a log entry is the undo. Counters recompute from what remains;
  // outreach status is left alone because it may have legitimately moved on.
  deleteCall: async (callId) => {
    const rows = await db.select("calls", `id=eq.${callId}`);
    if (!rows.length) throw new Error("not found");
    const leadId = rows[0].lead_id;
    await db.remove("calls", callId);
    const remaining = await db.select("calls", `lead_id=eq.${leadId}`);
    return db.update("leads", leadId, callCountersFrom(remaining));
  },

  // ---------- Disabled capabilities (acceptance 11) ----------
  runAudit: () => unavailable("audit"),
  findEmail: () => unavailable("findEmail"),
  scrape: () => unavailable("scrape"),

  // ---------- Clients ----------
  clients: () => db.select("clients", "order=created_at.desc"),

  updateClient: async (id, data) => {
    const allowed = [
      "business_name", "owner_name", "phone", "email", "project_status",
      "contract_value", "deliverables", "website_adjustments", "start_date", "due_date", "notes",
    ];
    const payload = {};
    for (const k of allowed) if (data[k] !== undefined) payload[k] = data[k];
    return db.update("clients", id, payload);
  },

  deleteClient: async (id) => {
    // Remove the stored objects before the rows that point at them. Doing it
    // in the other order would orphan the files in the bucket with no record
    // of what they were, and private-bucket orphans are invisible.
    const docs = await db.select("documents", `client_id=eq.${id}`);
    for (const doc of docs) {
      try {
        await storage.remove(objectPathFor(doc));
      } catch {
        // Already gone, or never uploaded. The row is being deleted anyway;
        // failing here would block the client delete on a missing file.
      }
    }
    // invoices and documents cascade from clients in the schema.
    return db.remove("clients", id);
  },

  // ---------- Documents ----------
  clientDocs: (id) => db.select("documents", `client_id=eq.${id}&order=uploaded_at.desc,id.desc`),

  recentDocs: () =>
    db.raw("/documents?select=*,clients(business_name)&order=uploaded_at.desc,id.desc&limit=12").then(
      // Flatten the embedded client so the shape matches the old LEFT JOIN
      // response the pages were written against.
      (rows) => rows.map(({ clients, ...d }) => ({ ...d, business_name: clients?.business_name || "" }))
    ),

  uploadDocs: async (clientId, fileList) => {
    const files = Array.from(fileList || []);
    for (const file of files) {
      const stored = storedName(file.name);
      // Upload first. If the object write fails, no row is created — a
      // documents row whose file does not exist is a broken download link
      // that looks fine in the list.
      await storage.upload(`${clientId}/${stored}`, file);
      try {
        await db.insert("documents", {
          client_id: Number(clientId),
          filename: file.name,
          stored_name: stored,
          mime: file.type || "",
          size: file.size,
        });
      } catch (err) {
        // Row insert failed after the object landed: remove the object so the
        // bucket does not accumulate files nothing references.
        try {
          await storage.remove(`${clientId}/${stored}`);
        } catch {
          /* best effort */
        }
        throw err;
      }
    }
    return db.select("documents", `client_id=eq.${clientId}&order=uploaded_at.desc,id.desc`);
  },

  // Async because the bucket is private: this mints a short-lived signed URL
  // per click. 60 seconds is enough to start the download and short enough
  // that a copied link is useless almost immediately.
  docUrl: async (docId, download = false) => {
    const rows = await db.select("documents", `id=eq.${docId}`);
    if (!rows.length) throw new Error("not found");
    return storage.signedUrl(objectPathFor(rows[0]), { expiresIn: 60, download });
  },

  deleteDoc: async (docId) => {
    const rows = await db.select("documents", `id=eq.${docId}`);
    if (!rows.length) throw new Error("not found");
    try {
      await storage.remove(objectPathFor(rows[0]));
    } catch {
      /* file already gone; still remove the row */
    }
    return db.remove("documents", docId);
  },

  // ---------- Invoices ----------
  invoices: () =>
    db
      .raw("/invoices?select=*,clients(business_name)&order=issue_date.desc,id.desc")
      .then((rows) =>
        rows.map(({ clients, ...inv }) => withTotal({ ...inv, business_name: clients?.business_name || "" }))
      ),

  clientInvoices: (id) =>
    db.select("invoices", `client_id=eq.${id}&order=issue_date.desc,id.desc`).then((rows) => rows.map(withTotal)),

  createInvoice: async (clientId, data = {}) => {
    const clients = await db.select("clients", `id=eq.${clientId}`);
    if (!clients.length) throw new Error("client not found");
    const client = clients[0];

    const year = new Date().getFullYear();
    const existing = await db.select("invoices", `select=number&number=like.INV-${year}-*`);
    const number = nextInvoiceNumber(existing.map((r) => r.number), year);

    const lineItems = data.line_items || [
      {
        description: client.deliverables || "Website design and build",
        qty: 1,
        rate: client.contract_value || 0,
      },
    ];

    // Carry the payment block forward from the last invoice that had one, so
    // it only ever has to be typed once. (The old server also had an env-var
    // default; there is no server env any more.)
    let payment = data.payment_instructions;
    if (!payment) {
      const prior = await db.select(
        "invoices",
        "select=payment_instructions&payment_instructions=neq.&order=id.desc&limit=1"
      );
      payment = prior[0]?.payment_instructions || "";
    }

    const created = await db.insert("invoices", {
      client_id: client.id,
      number,
      status: data.status || "Draft",
      issue_date: data.issue_date || today(),
      due_date: data.due_date || "",
      line_items: JSON.stringify(lineItems),
      tax_rate: data.tax_rate || 0,
      payment_instructions: payment,
      notes: data.notes || "",
    });
    return withTotal(created);
  },

  updateInvoice: async (invId, data) => {
    const rows = await db.select("invoices", `id=eq.${invId}`);
    if (!rows.length) throw new Error("not found");
    const existing = rows[0];

    const allowed = ["status", "issue_date", "due_date", "tax_rate", "payment_instructions", "notes", "paid_date"];
    const payload = {};
    for (const k of allowed) payload[k] = data[k] ?? existing[k];
    if (data.line_items) payload.line_items = JSON.stringify(data.line_items);

    // Marking Paid stamps the date; un-paying clears it, so a reverted invoice
    // never keeps a paid date it no longer earned.
    if (payload.status === "Paid" && !payload.paid_date) payload.paid_date = today();
    if (payload.status !== "Paid") payload.paid_date = "";

    return withTotal(await db.update("invoices", invId, payload));
  },

  deleteInvoice: async (invId) => {
    const rows = await db.select("invoices", `id=eq.${invId}`);
    if (!rows.length) throw new Error("not found");
    if (!canDeleteInvoice(rows[0])) {
      throw new Error("only Draft or Void invoices can be deleted; mark it Void instead");
    }
    return db.remove("invoices", invId);
  },

  // ---------- Templates ----------
  templates: () => db.select("email_templates", "order=id"),
  createTemplate: (data) =>
    db.insert("email_templates", {
      name: data.name,
      kind: data.kind || "initial",
      subject: data.subject || "",
      body: data.body || "",
    }),
  updateTemplate: (id, data) =>
    db.update("email_templates", id, {
      name: data.name,
      kind: data.kind,
      subject: data.subject,
      body: data.body,
    }),
  deleteTemplate: (id) => db.remove("email_templates", id),

  // ---------- Outreach ----------
  // Saves a draft. It does NOT send, and it deliberately does NOT advance
  // outreach_status or set last_contact_date, because nothing has been
  // contacted — claiming otherwise would silently burn the follow-up sequence
  // on mail that never left (acceptance 11).
  saveDraft: async ({ lead_id, template_id, subject, body }) => {
    const leads = await db.select("leads", `id=eq.${lead_id}`);
    if (!leads.length) throw new Error("lead not found");
    const lead = leads[0];
    const log = await db.insert("email_logs", {
      lead_id: lead.id,
      template_id: template_id || null,
      to_email: lead.email || "",
      subject: subject || "",
      body: body || "",
      status: "draft",
      scheduled_for: "",
    });
    return { draft: true, sent: false, log };
  },

  // Kept so a stale call site cannot quietly turn into a fake send.
  sendEmail: () => unavailable("sendEmail"),

  emailLogs: (leadId) =>
    leadId
      ? db.select("email_logs", `lead_id=eq.${leadId}&order=sent_at.desc`)
      : db
          .raw("/email_logs?select=*,leads(business_name)&order=sent_at.desc&limit=200")
          .then((rows) =>
            rows.map(({ leads, ...l }) => ({ ...l, business_name: leads?.business_name || "" }))
          ),
};

export const OUTREACH_STATUSES = [
  "Not Contacted", "Contacted", "Follow-Up 1", "Follow-Up 2", "Replied",
  "Interested", "Booked", "Closed", "Not Interested",
];

export const WEBSITE_STATUSES = ["No Website", "Has Website", "Outdated"];

export const PROJECT_STATUSES = ["Discovery", "In Progress", "Review", "Completed", "On Hold"];

export const STATUS_COLORS = {
  "Not Contacted": "bg-dim/10 text-dim border-dim/30",
  Contacted: "bg-ember/10 text-ember border-ember/30",
  "Follow-Up 1": "bg-emberhi/10 text-emberhi border-emberhi/30",
  "Follow-Up 2": "bg-emberhi/15 text-emberhi border-emberhi/40",
  Replied: "bg-teal/10 text-teal border-teal/30",
  Interested: "bg-violet/10 text-violet border-violet/30",
  Booked: "bg-mint/10 text-mint border-mint/30",
  Closed: "bg-ember/20 text-emberhi border-ember/50",
  "Not Interested": "bg-coral/10 text-coral border-coral/30",
  Discovery: "bg-ember/10 text-ember border-ember/30",
  "In Progress": "bg-violet/10 text-violet border-violet/30",
  Review: "bg-emberhi/10 text-emberhi border-emberhi/30",
  Completed: "bg-mint/10 text-mint border-mint/30",
  "On Hold": "bg-dim/10 text-dim border-dim/30",
  Draft: "bg-dim/10 text-dim border-dim/30",
  Sent: "bg-ember/10 text-ember border-ember/30",
  Paid: "bg-mint/10 text-mint border-mint/30",
  Void: "bg-coral/10 text-coral border-coral/30",
};

// Hex twins of the badge colors, for map markers and inline glows.
export const STATUS_HEX = {
  "Not Contacted": "#8fa3bc",
  Contacted: "#c24b2e",
  "Follow-Up 1": "#d6673f",
  "Follow-Up 2": "#d6673f",
  Replied: "#2a5fa8",
  Interested: "#b9d7ec",
  Booked: "#57c08a",
  Closed: "#c24b2e",
  "Not Interested": "#e5484d",
};

export function cityFrom(location) {
  const parts = (location || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 3];
  return parts[0] || "";
}

export function siteIssue(lead) {
  const fallback = "a few things on your site are quietly working against you on Google";
  try {
    const rep = JSON.parse(lead.audit_report || "null");
    if (!rep?.checks) return fallback;
    const find = (name) => rep.checks.find((c) => c.name === name);
    const bad = (name) => { const c = find(name); return c && c.status !== "pass"; };
    if (bad("Site reachable")) return "your website wasn't loading at all when I checked";
    if (bad("Mobile viewport")) return "your site doesn't adjust for phones, and that's where most local customers are searching from";
    const lt = find("Load time");
    if (lt && lt.status !== "pass") {
      const ms = Number(lt.detail.match(/\d+/)?.[0] || 0);
      return `your site took about ${(ms / 1000).toFixed(1)} seconds to come up when I checked, and people give up fast`;
    }
    if (bad("HTTPS")) return 'your site loads without the padlock, so browsers warn visitors it is "not secure"';
    if (bad("Contact form")) return "there's no way for a visitor to send you a message from your homepage, so after-hours customers have nowhere to go";
    if (bad("Meta description")) return "Google is writing its own description of your business under your search result instead of the one you'd choose";
    if (bad("Tap-to-call link")) return "your phone number isn't tappable on a phone, so calling you takes copy-and-paste";
    if (bad("Title tag")) return "your homepage isn't telling Google clearly what you do";
    return fallback;
  } catch {
    return fallback;
  }
}

export function fillTemplate(text, lead) {
  if (!lead) return text || "";
  const first = (lead.owner_name || "").trim().split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : `Hi ${lead.business_name} team,`;
  return (text || "")
    .replaceAll("{greeting}", greeting)
    .replaceAll("{business_name}", lead.business_name || "")
    .replaceAll("{owner_name}", lead.owner_name || "there")
    .replaceAll("{city}", cityFrom(lead.location))
    .replaceAll("{industry}", lead.industry || "")
    .replaceAll("{rating}", String(lead.star_rating || ""))
    .replaceAll("{reviews}", String(lead.review_count || ""))
    .replaceAll("{site_issue}", siteIssue(lead));
}

// Joins the parts of a meta line, skipping blanks so a missing owner never
// leaves a dangling separator.
export function meta(...parts) {
  return parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== "").join(" · ");
}

// "2026-07-29" for today + n days — quick-set follow-up dates.
export function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

export function scoreColor(score) {
  if (score >= 75) return "text-emberhi";
  if (score >= 50) return "text-ink/80";
  return "text-dim";
}
