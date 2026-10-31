import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, OUTREACH_STATUSES, WEBSITE_STATUSES, PROJECT_STATUSES, daysFromNow } from "../api.js";
import { Modal, Field, ScoreRing } from "./ui.jsx";
import { openAuditReport } from "../reportExport.js";

const TABS = ["Details", "Audit", "Score", "Call Tracker", "Emails", "Actions"];

export default function LeadModal({ lead, onClose, onSaved }) {
  const [tab, setTab] = useState("Details");
  const [form, setForm] = useState(lead || {});
  const [breakdown, setBreakdown] = useState([]);
  const [emails, setEmails] = useState([]);
  const [report, setReport] = useState(null);
  const [auditing, setAuditing] = useState(false);
  const [findBusy, setFindBusy] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [calls, setCalls] = useState([]);
  const [convert, setConvert] = useState({ project_status: "Discovery", contract_value: "", deliverables: "", due_date: "" });
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    setForm(lead || {});
    setTab("Details");
    try {
      setReport(lead?.audit_report ? JSON.parse(lead.audit_report) : null);
    } catch {
      setReport(null);
    }
    if (lead?.id) {
      api.scoreBreakdown(lead.id).then(setBreakdown).catch(() => setBreakdown([]));
      api.emailLogs(lead.id).then(setEmails).catch(() => setEmails([]));
      api.leadCalls(lead.id).then(setCalls).catch(() => setCalls([]));
    }
  }, [lead]);

  if (!lead) return null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save(extra = {}) {
    setBusy(true);
    try {
      await api.updateLead(lead.id, { ...form, ...extra });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function undoCall(callId) {
    const updated = await api.deleteCall(callId);
    setForm(updated);
    api.leadCalls(lead.id).then(setCalls);
    onSaved(true); // silent refresh, keep modal open
  }

  async function doAudit() {
    setAuditing(true);
    try {
      setReport(await api.runAudit(lead.id));
      onSaved(true); // silent refresh so audit_date persists in the row data
    } catch (err) {
      alert("Audit failed: " + err.message);
    } finally {
      setAuditing(false);
    }
  }

  async function doConvert() {
    setBusy(true);
    try {
      await api.convertLead(lead.id, { ...convert, contract_value: Number(convert.contract_value) || 0 });
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const counters = [
    ["calls_total", "Total Calls"],
    ["calls_contacted", "Contacted"],
    ["calls_not_interested", "Not Interested"],
    ["calls_voicemail", "Voicemail"],
    ["calls_booked_demo", "Booked Demo"],
  ];

  return (
    <Modal open={!!lead} onClose={onClose} title={lead.business_name} wide>
      <div className="flex gap-2 mb-3 flex-wrap text-xs">
        {lead.phone && <a className="btn-ghost !py-1" href={`tel:${lead.phone}`}>☎ {lead.phone}</a>}
        {lead.email && (
          <button
            className="btn-ghost !py-1"
            onClick={() => {
              localStorage.setItem("compose_lead_id", String(lead.id));
              onClose();
              navigate("/outreach");
            }}
          >
            ✉ Compose Email
          </button>
        )}
        {lead.website_url && <a className="btn-ghost !py-1" href={lead.website_url} target="_blank" rel="noreferrer">↗ Current Site</a>}
        <a
          className="btn-ghost !py-1"
          href={`https://www.google.com/maps/search/${encodeURIComponent(`${lead.business_name} ${lead.location}`)}`}
          target="_blank"
          rel="noreferrer"
        >
          ⌖ Maps Listing
        </a>
      </div>
      <div className="flex gap-1 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t}
            className={`btn text-xs ${tab === t ? "bg-ember/20 text-emberhi border border-ember/40" : "btn-ghost"}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Details" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Business Name"><input className="input" value={form.business_name || ""} onChange={set("business_name")} /></Field>
          <Field label="Owner"><input className="input" value={form.owner_name || ""} onChange={set("owner_name")} /></Field>
          <Field label="Phone"><input className="input" value={form.phone || ""} onChange={set("phone")} /></Field>
          <Field label="Email">
            <div className="flex gap-1.5">
              <input className="input" value={form.email || ""} onChange={set("email")} />
              {form.website_url && (
                <button type="button" className="btn-ghost !px-2 !py-1 text-xs shrink-0" disabled={findBusy}
                  onClick={async () => {
                    setFindBusy(true);
                    try { setCandidates((await api.findEmail(lead.id)).emails); }
                    catch { setCandidates([]); }
                    finally { setFindBusy(false); }
                  }}>
                  {findBusy ? "..." : "Find"}
                </button>
              )}
            </div>
            {candidates && (
              candidates.length ? (
                <div className="flex flex-wrap gap-1 mt-1">
                  {candidates.map((e) => (
                    <button key={e} type="button" className="btn-ghost !py-0.5 !px-2 text-xs"
                      onClick={() => { setForm({ ...form, email: e }); setCandidates(null); }}>
                      {e}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-coral mt-1">nothing found on their site</div>
              )
            )}
          </Field>
          <Field label="Location"><input className="input" value={form.location || ""} onChange={set("location")} /></Field>
          <Field label="Industry"><input className="input" value={form.industry || ""} onChange={set("industry")} /></Field>
          <Field label="Website Status">
            <select className="input" value={form.website_status || ""} onChange={set("website_status")}>
              {WEBSITE_STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Website URL"><input className="input" value={form.website_url || ""} onChange={set("website_url")} /></Field>
          <Field label="Outreach Status">
            <select className="input" value={form.outreach_status || ""} onChange={set("outreach_status")}>
              {OUTREACH_STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Outreach Channel">
            <select className="input" value={form.outreach_channel || ""} onChange={set("outreach_channel")}>
              <option value="">-</option><option>Email</option><option>Phone</option><option>In Person</option><option>Social</option>
            </select>
          </Field>
          <Field label="Last Contact"><input type="date" className="input" value={form.last_contact_date || ""} onChange={set("last_contact_date")} /></Field>
          <Field label="Next Follow-Up">
            <div className="flex gap-1.5">
              <input type="date" className="input" value={form.next_followup_date || ""} onChange={set("next_followup_date")} />
              {[["+1d", 1], ["+3d", 3], ["+1w", 7]].map(([lbl, n]) => (
                <button key={lbl} type="button" className="btn-ghost !px-2 !py-1 text-xs shrink-0"
                  onClick={() => setForm({ ...form, next_followup_date: daysFromNow(n) })}>{lbl}</button>
              ))}
            </div>
          </Field>
          <div className="md:col-span-2">
            <Field label="Notes"><textarea className="input min-h-[70px]" value={form.notes || ""} onChange={set("notes")} /></Field>
          </div>
          <div className="md:col-span-2 flex justify-end">
            <button className="btn-primary" disabled={busy} onClick={() => save()}>Save</button>
          </div>
        </div>
      )}

      {tab === "Audit" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 className="font-semibold text-sm">Website Diagnostics</h3>
              <p className="text-xs text-dim">{form.website_url ? `Technical scan of ${form.website_url}` : "No website URL on this lead — nothing to scan."}</p>
            </div>
            <div className="flex gap-2">
              {report && (
                <button className="btn-ghost" onClick={() => openAuditReport(lead, report)}>⎙ Export Report</button>
              )}
              <button className="btn-primary" disabled={busy || auditing || !form.website_url} onClick={doAudit}>
                {auditing ? "Scanning..." : report ? "Re-run Diagnostics" : "Run Diagnostics"}
              </button>
            </div>
          </div>

          {report && (
            <div className="glass !rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-4 mb-2">
                <span className="numeral text-4xl">{report.grade}</span>
                <div className="text-xs text-dim">
                  <div>{report.score}/100 · scanned {report.scanned || report.fetched_at?.slice(0, 10)}</div>
                  <div className="truncate max-w-[320px]">{report.url}</div>
                </div>
              </div>
              {report.checks.map((c) => (
                <div key={c.name} className="flex items-start gap-2 text-sm">
                  <span className={c.status === "pass" ? "text-mint" : c.status === "warn" ? "text-emberhi" : "text-coral"}>
                    {c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✗"}
                  </span>
                  <span className="w-44 shrink-0">{c.name}</span>
                  <span className="text-dim text-xs pt-0.5">{c.detail}</span>
                </div>
              ))}
              <p className="text-xs text-dim pt-1">Every ✗ and ! is a pitch point. For the full nine-page marketing brief on a hot lead, ask Vale.</p>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!Number(form.audit_sent)}
              onChange={(e) => setForm({ ...form, audit_sent: e.target.checked ? 1 : 0 })}
            />
            Audit sent to this lead
          </label>
          <Field label="Audit Notes">
            <textarea className="input min-h-[120px]" value={form.audit_notes || ""} onChange={set("audit_notes")} placeholder="What's wrong with their current web presence, what you'd pitch..." />
          </Field>
          <div className="flex justify-end">
            <button className="btn-primary" disabled={busy} onClick={() => save()}>Save</button>
          </div>
        </div>
      )}

      {tab === "Score" && (
        <div className="flex flex-col md:flex-row gap-6 items-start">
          <div className="flex flex-col items-center gap-1 mx-auto md:mx-0">
            <ScoreRing value={lead.lead_score} size={110} />
            <span className="micro">lead score</span>
          </div>
          <div className="space-y-3 flex-1 w-full">
            {breakdown.map((b) => (
              <div key={b.label}>
                <div className="flex justify-between text-sm mb-1">
                  <span>{b.label} <span className="text-dim text-xs">({b.detail})</span></span>
                  <span className="text-dim">{b.points}/{b.max}</span>
                </div>
                <div className="h-1.5 rounded-full bg-ink/5">
                  <div className="h-1.5 rounded-full bg-gradient-to-r from-ember to-emberhi" style={{ width: `${(b.points / b.max) * 100}%`, boxShadow: "0 0 8px rgba(194,75,46,0.4)" }} />
                </div>
              </div>
            ))}
            <p className="text-xs text-dim">Score recalculates automatically when you save changes to website status, rating, reviews, email, or phone.</p>
          </div>
        </div>
      )}

      {tab === "Call Tracker" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {counters.map(([key, label]) => (
              <div key={key} className="glass !rounded-xl p-3 text-center">
                <div className="numeral text-2xl">{form[key] || 0}</div>
                <div className="text-xs text-dim">{label}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1">
            <div className="micro">call log — ✕ removes an entry and the tallies recompute</div>
            {calls.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 bg-ink/5 rounded-lg px-3 py-1.5 text-xs">
                <span className="text-dim truncate">
                  {c.called_at?.slice(0, 16)} · <span className="text-ink/80">{c.outcome.replace("_", " ")}</span>
                  {c.note && <span> — {c.note}</span>}
                </span>
                <button className="text-coral opacity-50 hover:opacity-100 shrink-0" onClick={() => undoCall(c.id)}>✕</button>
              </div>
            ))}
            {!calls.length && <p className="text-sm text-dim">No calls logged yet.</p>}
          </div>
          <p className="text-xs text-dim">Calls are logged from the Outreach page, where the outcome, note, and follow-up commit together.</p>
        </div>
      )}

      {tab === "Emails" && (
        <div className="space-y-2">
          {emails.map((e) => (
            <div key={e.id} className="bg-ink/5 rounded-lg px-3 py-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium">{e.subject}</span>
                <span className={e.status === "sent" ? "text-mint" : e.status === "mock" ? "text-emberhi" : "text-coral"}>{e.status}</span>
              </div>
              <div className="text-xs text-dim mt-0.5">{e.sent_at} → {e.to_email}</div>
              <details className="text-xs text-dim mt-1">
                <summary className="cursor-pointer hover:text-ink">body</summary>
                <pre className="whitespace-pre-wrap font-sans mt-1 text-ink/70">{e.body}</pre>
              </details>
            </div>
          ))}
          {!emails.length && <p className="text-sm text-dim">No emails sent to this lead yet.</p>}
        </div>
      )}

      {tab === "Actions" && (
        <div className="space-y-5">
          <div className="glass !rounded-xl p-4 space-y-3">
            <h3 className="font-semibold text-sm">Convert to Client</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Project Status">
                <select className="input" value={convert.project_status} onChange={(e) => setConvert({ ...convert, project_status: e.target.value })}>
                  {PROJECT_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Contract Value ($)"><input type="number" className="input" value={convert.contract_value} onChange={(e) => setConvert({ ...convert, contract_value: e.target.value })} /></Field>
              <Field label="Deliverables"><input className="input" value={convert.deliverables} onChange={(e) => setConvert({ ...convert, deliverables: e.target.value })} placeholder="5-page site, contact form..." /></Field>
              <Field label="Due Date"><input type="date" className="input" value={convert.due_date} onChange={(e) => setConvert({ ...convert, due_date: e.target.value })} /></Field>
            </div>
            <button className="btn-primary" disabled={busy} onClick={doConvert}>Convert to Client</button>
          </div>
          <div className="flex justify-between">
            <button
              className="btn-danger"
              disabled={busy}
              onClick={async () => {
                if (!confirm(`Delete lead "${lead.business_name}"? This can't be undone.`)) return;
                await api.deleteLead(lead.id);
                onSaved();
                onClose();
              }}
            >
              Delete Lead
            </button>
            <button className="btn-primary" disabled={busy} onClick={() => save()}>Save All Changes</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
