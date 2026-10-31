// A 401 means this browser has no usable session. Notify the app shell so it
// can drop protected state and show login, instead of letting every page
// render its own error toast about data it will never get.
export const AUTH_LOST_EVENT = "gapvera:auth-lost";

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    // Session cookie must ride along; the Vite dev proxy is a different origin.
    credentials: "same-origin",
    ...options,
  });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, { detail: { reason: body.reason || "unauthenticated" } }));
    const err = new Error(body.reason === "expired" ? "Your session expired." : "Please sign in.");
    err.authLost = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    if (res.status === 429) err.retryAfterSeconds = body.retry_after_seconds;
    throw err;
  }
  return res.json();
}

export const auth = {
  status: () => request("/auth/status"),
  setup: (password, confirmPassword) =>
    request("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password, confirm_password: confirmPassword }),
    }),
  login: (username, password) =>
    request("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request("/auth/logout", { method: "POST" }),
};

export const api = {
  config: () => request("/config"),
  leads: () => request("/leads"),
  scoreBreakdown: (id) => request(`/leads/${id}/score`),
  createLead: (data) => request("/leads", { method: "POST", body: JSON.stringify(data) }),
  bulkImport: (rows) => request("/leads/bulk", { method: "POST", body: JSON.stringify(rows) }),
  updateLead: (id, data) => request(`/leads/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteLead: (id) => request(`/leads/${id}`, { method: "DELETE" }),
  convertLead: (id, data) => request(`/leads/${id}/convert`, { method: "POST", body: JSON.stringify(data) }),
  logCall: (id, outcome, note = "", followupDays = null) =>
    request(`/leads/${id}/call`, { method: "POST", body: JSON.stringify({ outcome, note, followup_days: followupDays }) }),
  leadCalls: (id) => request(`/leads/${id}/calls`),
  deleteCall: (callId) => request(`/calls/${callId}`, { method: "DELETE" }),
  runAudit: (id) => request(`/leads/${id}/run-audit`, { method: "POST" }),
  findEmail: (id) => request(`/leads/${id}/find-email`, { method: "POST" }),
  clients: () => request("/clients"),
  clientDocs: (id) => request(`/clients/${id}/documents`),
  uploadDocs: async (id, fileList) => {
    const fd = new FormData();
    for (const f of fileList) fd.append("files", f);
    const res = await fetch(`/api/clients/${id}/documents`, {
      method: "POST",
      body: fd,
      credentials: "same-origin",
    });
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, { detail: { reason: "unauthenticated" } }));
      throw new Error("Please sign in.");
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  },
  deleteDoc: (docId) => request(`/documents/${docId}`, { method: "DELETE" }),
  recentDocs: () => request("/recent-documents"),
  invoices: () => request("/invoices"),
  clientInvoices: (id) => request(`/clients/${id}/invoices`),
  createInvoice: (id, data = {}) => request(`/clients/${id}/invoices`, { method: "POST", body: JSON.stringify(data) }),
  updateInvoice: (invId, data) => request(`/invoices/${invId}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteInvoice: (invId) => request(`/invoices/${invId}`, { method: "DELETE" }),
  docUrl: (docId, download = false) => `/api/documents/${docId}${download ? "?download=1" : ""}`,
  updateClient: (id, data) => request(`/clients/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteClient: (id) => request(`/clients/${id}`, { method: "DELETE" }),
  templates: () => request("/templates"),
  createTemplate: (data) => request("/templates", { method: "POST", body: JSON.stringify(data) }),
  updateTemplate: (id, data) => request(`/templates/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTemplate: (id) => request(`/templates/${id}`, { method: "DELETE" }),
  sendEmail: (data) => request("/send-email", { method: "POST", body: JSON.stringify(data) }),
  emailLogs: (leadId) => request(`/email-logs${leadId ? `?lead_id=${leadId}` : ""}`),
  scrape: (niche, city) => request("/scrape", { method: "POST", body: JSON.stringify({ niche, city }) }),
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

// Client-side twin of the server's placeholder fill, for composer previews.
// Keep in lockstep with server/mailer.js.
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
