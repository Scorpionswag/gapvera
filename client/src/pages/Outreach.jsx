import { useEffect, useMemo, useState } from "react";
import { api, fillTemplate, daysFromNow, meta, OUTREACH_STATUSES, UNAVAILABLE } from "../api.js";
import { Badge, Score, Field, Modal } from "../components/ui.jsx";
import { openAuditReport } from "../reportExport.js";

const KINDS = [["initial", "Initial"], ["followup1", "Follow-Up 1"], ["followup2", "Follow-Up 2"]];
// Monochrome glyphs only: colored emoji broke the palette.
const CALL_OUTCOMES = [
  ["contacted", "✓ Talked to them"],
  ["voicemail", "☎ Left a voicemail"],
  ["no_answer", "∅ No answer"],
  ["booked_demo", "★ Booked a demo!"],
  ["not_interested", "✕ Not interested"],
];

const OUTCOME_LABELS = Object.fromEntries(CALL_OUTCOMES);

// Suggest the right template for where this lead is: sequence stage from
// outreach status, and for first-touch, the pitch that fits their website
// situation.
function suggestTemplate(lead, templates) {
  const stage =
    lead.outreach_status === "Contacted" ? "followup1"
    : ["Follow-Up 1", "Follow-Up 2"].includes(lead.outreach_status) ? "followup2"
    : "initial";
  const pool = templates.filter((t) => t.kind === stage);
  if (stage === "initial" && pool.length > 1) {
    const noSite = lead.website_status === "No Website";
    const match = pool.find((t) => (noSite ? /no website/i.test(t.name) : /fix|checkup/i.test(t.name)));
    if (match) return match;
  }
  return pool[0] || null;
}

// Outreach is the work-session page: queue on the left, everything needed to
// work one lead — call, log, schedule, note, email — on the right.
export default function Outreach({ leads, refresh }) {
  const [templates, setTemplates] = useState([]);
  const [leadLogs, setLeadLogs] = useState([]);
  const [allLogs, setAllLogs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [queueMode, setQueueMode] = useState("work");
  const [search, setSearch] = useState("");
  const [compose, setCompose] = useState({ template_id: "", subject: "", body: "" });
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState("");
  const [notes, setNotes] = useState("");
  const [pendingOutcome, setPendingOutcome] = useState(null);
  const [callNote, setCallNote] = useState("");
  const [callFollowup, setCallFollowup] = useState(null);
  const [callEvents, setCallEvents] = useState([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const selected = leads.find((l) => l.id === selectedId) || null;
  const today = new Date().toISOString().slice(0, 10);

  const loadTemplates = () => { api.templates().then(setTemplates); };
  useEffect(loadTemplates, []);

  // Honor deep links from Email buttons elsewhere in the app.
  useEffect(() => {
    const pre = localStorage.getItem("compose_lead_id");
    if (pre) {
      localStorage.removeItem("compose_lead_id");
      setSelectedId(Number(pre));
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    setNotes(selected.notes || "");
    setMsg("");
    api.emailLogs(selected.id).then(setLeadLogs).catch(() => setLeadLogs([]));
    api.leadCalls(selected.id).then(setCallEvents).catch(() => setCallEvents([]));
    setPendingOutcome(null);
    setCallNote("");
    setCallFollowup(null);
    // Preload the template that fits this lead's stage and website situation.
    const t = suggestTemplate(selected, templates);
    setCompose(t ? { template_id: String(t.id), subject: t.subject, body: t.body } : { template_id: "", subject: "", body: "" });
  }, [selectedId, templates.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const queue = useMemo(() => {
    const dead = ["Closed", "Not Interested"];
    const q = search.toLowerCase();
    let list = leads.filter(
      (l) =>
        (!q || [l.business_name, l.owner_name, l.location, l.industry].join(" ").toLowerCase().includes(q)) &&
        (queueMode === "all" || !dead.includes(l.outreach_status))
    );
    // Due follow-ups first (oldest first), then best score.
    return list.sort((a, b) => {
      const aDue = a.next_followup_date && a.next_followup_date <= today ? 0 : 1;
      const bDue = b.next_followup_date && b.next_followup_date <= today ? 0 : 1;
      if (aDue !== bDue) return aDue - bDue;
      if (aDue === 0) return (a.next_followup_date || "").localeCompare(b.next_followup_date || "");
      return b.lead_score - a.lead_score;
    });
  }, [leads, search, queueMode, today]);

  function pickTemplate(id) {
    const t = templates.find((t) => t.id === Number(id));
    setCompose({ template_id: id, subject: t?.subject || "", body: t?.body || "" });
  }

  // Saves the composed message as a draft. It does not send — there is no mail
  // provider in this build — and it deliberately leaves outreach_status and
  // last_contact_date alone, because nothing has reached the prospect yet.
  // Advancing the sequence here would silently burn a follow-up step on mail
  // that was never delivered (acceptance 11).
  async function saveDraft() {
    setSending(true);
    setMsg("");
    try {
      await api.saveDraft({
        lead_id: selected.id,
        template_id: Number(compose.template_id) || null,
        subject: compose.subject,
        body: compose.body,
      });
      setMsg("Draft saved. Copy it into your email client to send.");
      api.emailLogs(selected.id).then(setLeadLogs);
      refresh();
    } catch (err) {
      setMsg("Failed: " + err.message);
    } finally {
      setSending(false);
    }
  }

  // The manual send path: put the filled-in message on the clipboard so it can
  // go straight into a real mail client. Falls back to a visible message rather
  // than failing silently, because clipboard access is permission-gated.
  async function copyMessage() {
    const text = `To: ${selected.email}\nSubject: ${fillTemplate(compose.subject, selected)}\n\n${fillTemplate(compose.body, selected)}`;
    try {
      await navigator.clipboard.writeText(text);
      setMsg("Copied — paste it into your email client.");
    } catch {
      setMsg("Could not access the clipboard. Select the preview text above and copy it manually.");
    }
  }

  // Email discovery required a server to fetch the prospect's site; a browser
  // cannot do that cross-origin. The button is gone and this explains why.
  const findEmailInfo = UNAVAILABLE.findEmail;

  async function commitCall() {
    await api.logCall(selected.id, pendingOutcome, callNote.trim(), callFollowup);
    setPendingOutcome(null);
    setCallNote("");
    setCallFollowup(null);
    api.leadCalls(selected.id).then(setCallEvents);
    refresh();
  }

  async function undoCall(callId) {
    await api.deleteCall(callId);
    api.leadCalls(selected.id).then(setCallEvents);
    refresh();
  }

  const grade = (() => {
    try { return selected?.audit_report ? JSON.parse(selected.audit_report).grade : null; } catch { return null; }
  })();

  // Fixed-height cockpit on desktop: the page never scrolls, each panel
  // scrolls inside itself, so the whole work session stays on one screen.
  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100vh-4rem)]">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Outreach</h1>
        <div className="flex gap-2">
          <button className="btn-ghost text-xs" onClick={() => setManageOpen(true)}>Manage Templates</button>
          <button className="btn-ghost text-xs" onClick={() => { api.emailLogs().then(setAllLogs); setHistoryOpen(true); }}>Email History</button>
        </div>
      </div>

      <div className="grid lg:grid-cols-[320px,1fr] gap-4 items-start lg:items-stretch lg:flex-1 lg:min-h-0">
        {/* Queue */}
        <div className="glass p-3 flex flex-col gap-2 lg:min-h-0">
          <input className="input" placeholder="Search queue..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="flex gap-1">
            {[["work", "Work Queue"], ["all", "Everyone"]].map(([m, label]) => (
              <button key={m} className={`btn text-xs flex-1 ${queueMode === m ? "bg-ember/15 text-emberhi border border-ember/30" : "btn-ghost"}`} onClick={() => setQueueMode(m)}>
                {label}
              </button>
            ))}
          </div>
          <div className="space-y-1 overflow-y-auto pr-1 max-h-[46vh] lg:max-h-none lg:flex-1 lg:min-h-0">
            {queue.map((l) => {
              const due = l.next_followup_date && l.next_followup_date <= today;
              return (
                <button
                  key={l.id}
                  onClick={() => setSelectedId(l.id)}
                  className={`w-full text-left rounded-lg px-3 py-2 border transition-colors ${
                    l.id === selectedId ? "bg-ember/10 border-ember/30" : "border-transparent hover:bg-ink/5"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">{l.business_name}</span>
                    <Score value={l.lead_score} />
                  </div>
                  <div className="flex items-center gap-2 text-xs text-dim mt-0.5">
                    <Badge>{l.outreach_status}</Badge>
                    <span>{l.phone ? "☎" : ""}{l.email ? " ✉" : ""}</span>
                    {due && <span className="text-coral">due {l.next_followup_date}</span>}
                  </div>
                </button>
              );
            })}
            {!queue.length && <p className="text-sm text-dim p-2">Queue's empty — import leads from Scrape.</p>}
          </div>
        </div>

        {/* Workspace */}
        {selected ? (
          <div className="flex flex-col gap-4 lg:min-h-0">
            <div className="glass p-4 shrink-0">
              <div className="flex items-start justify-between flex-wrap gap-2">
                <div>
                  <h2 className="font-display text-xl">{selected.business_name}</h2>
                  <div className="text-xs text-dim truncate max-w-[420px]">{meta(selected.owner_name || "owner unknown", selected.location, selected.industry)}</div>
                </div>
                <div className="flex items-center gap-2">
                  {grade && <span className="micro border border-ember/30 rounded px-1.5 py-0.5">site {grade}</span>}
                  <Badge>{selected.outreach_status}</Badge>
                  <Score value={selected.lead_score} />
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-3 text-xs">
                {selected.phone && <a className="btn-ghost !py-1" href={`tel:${selected.phone}`}>☎ {selected.phone}</a>}
                {selected.website_url && <a className="btn-ghost !py-1" href={selected.website_url} target="_blank" rel="noreferrer">↗ Site</a>}
                {grade && <button className="btn-ghost !py-1" onClick={() => openAuditReport(selected)}>⎙ Report</button>}
                <a className="btn-ghost !py-1" target="_blank" rel="noreferrer"
                  href={`https://www.google.com/maps/search/${encodeURIComponent(`${selected.business_name} ${selected.location}`)}`}>
                  ⌖ Maps
                </a>
                <select className="input !w-auto !py-1 text-xs" value={selected.outreach_status}
                  onChange={async (e) => { await api.updateLead(selected.id, { outreach_status: e.target.value }); refresh(); }}>
                  {OUTREACH_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
                <span className="flex items-center gap-1">
                  <span className="micro">follow-up</span>
                  {[["+1d", 1], ["+3d", 3], ["+1w", 7]].map(([lbl, n]) => (
                    <button key={lbl} className="btn-ghost !py-1 !px-2 text-xs"
                      onClick={async () => { await api.updateLead(selected.id, { next_followup_date: daysFromNow(n) }); refresh(); }}>
                      {lbl}
                    </button>
                  ))}
                  {selected.next_followup_date && <span className="text-dim text-xs ml-1">{selected.next_followup_date}</span>}
                </span>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4 items-start md:items-stretch lg:flex-1 lg:min-h-0">
              {/* Phone + notes */}
              <div className="glass p-4 space-y-3 lg:overflow-y-auto lg:min-h-0">
                <h3 className="font-semibold text-sm">Phone</h3>
                {selected.phone ? (
                  <>
                    <a className="btn-primary block text-center" href={`tel:${selected.phone}`}>☎ Call {selected.phone}</a>
                    <div className="micro pt-1">after you hang up, tap what happened:</div>
                    <div className="grid grid-cols-2 gap-2">
                      {CALL_OUTCOMES.map(([outcome, label]) => (
                        <button
                          key={outcome}
                          className={`btn text-xs !py-2 ${pendingOutcome === outcome ? "bg-ember/20 text-emberhi border border-ember/40" : "btn-ghost"}`}
                          onClick={() => setPendingOutcome(pendingOutcome === outcome ? null : outcome)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {pendingOutcome && (
                      <div className="bg-ink/5 border border-ember/20 rounded-lg p-3 space-y-2">
                        <div className="text-xs">Logging: <span className="text-emberhi font-medium">{OUTCOME_LABELS[pendingOutcome]}</span></div>
                        <input
                          className="input text-xs"
                          placeholder="Optional note: what they said, callback time, gatekeeper's name..."
                          value={callNote}
                          onChange={(e) => setCallNote(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && commitCall()}
                          autoFocus
                        />
                        <div className="flex items-center gap-1 flex-wrap">
                          <span className="micro">follow-up:</span>
                          {[["none", null], ["+1d", 1], ["+3d", 3], ["+1w", 7]].map(([lbl, n]) => (
                            <button key={lbl} className={`btn !py-0.5 !px-2 text-xs ${callFollowup === n ? "bg-ember/20 text-emberhi border border-ember/40" : "btn-ghost"}`}
                              onClick={() => setCallFollowup(n)}>
                              {lbl}
                            </button>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <button className="btn-primary text-xs" onClick={commitCall}>Log Call</button>
                          <button className="btn-ghost text-xs" onClick={() => { setPendingOutcome(null); setCallNote(""); setCallFollowup(null); }}>Cancel</button>
                        </div>
                      </div>
                    )}

                    {callEvents.length > 0 && (
                      <div className="text-xs space-y-1 pt-1 border-t border-ink/10">
                        <div className="micro">recent calls ({selected.calls_total || 0} total) — ✕ to undo</div>
                        {callEvents.slice(0, 5).map((c) => (
                          <div key={c.id} className="flex items-center justify-between gap-2 group">
                            <span className="text-dim truncate">
                              {c.called_at?.slice(0, 16)} · <span className="text-ink/80">{OUTCOME_LABELS[c.outcome] || c.outcome}</span>
                              {c.note && <span className="text-dim"> — {c.note}</span>}
                            </span>
                            <button className="text-coral opacity-40 hover:opacity-100 shrink-0" title="Delete this call from the log"
                              onClick={() => undoCall(c.id)}>✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-dim">No phone number on this lead.</p>
                )}
                <Field label="Notes">
                  <textarea className="input min-h-[90px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What they said, gatekeeper's name, best time to call back..." />
                </Field>
                <button className="btn-ghost text-xs" onClick={async () => { await api.updateLead(selected.id, { notes }); refresh(); }}>Save Notes</button>
              </div>

              {/* Email */}
              <div className="glass p-4 space-y-3 lg:overflow-y-auto lg:min-h-0">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <h3 className="font-semibold text-sm">Email</h3>
                  {/* Criterion 11: the limitation is stated where the work
                      happens, not buried in a settings page. */}
                  <span className="micro text-dim">drafts only — sending is unavailable</span>
                </div>
                {selected.email ? (
                  <>
                    <div className="text-xs text-dim">to <span className="text-ink">{selected.email}</span></div>
                    <select className="input" value={compose.template_id} onChange={(e) => pickTemplate(e.target.value)}>
                      <option value="">Blank / custom</option>
                      {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <input className="input" placeholder="Subject" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} />
                    <textarea className="input min-h-[110px]" placeholder="Body" value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} />
                    {(compose.subject || compose.body) && (
                      <div className="bg-ink/5 border border-ink/10 rounded-lg p-3 max-h-[190px] overflow-y-auto shrink-0">
                        <div className="micro mb-1">preview, exactly what they receive</div>
                        <div className="text-sm font-medium">{fillTemplate(compose.subject, selected)}</div>
                        <pre className="whitespace-pre-wrap font-sans text-xs text-ink/70 mt-1">{fillTemplate(compose.body, selected)}</pre>
                      </div>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button className="btn-primary" disabled={sending || !compose.subject} onClick={saveDraft}>
                        {sending ? "Saving…" : "Save draft"}
                      </button>
                      <button className="btn-ghost text-xs" disabled={!compose.subject && !compose.body} onClick={copyMessage}>
                        Copy for sending
                      </button>
                    </div>
                    {msg && <span className="text-xs text-emberhi block">{msg}</span>}
                    <p className="micro leading-relaxed">
                      GapVera cannot send mail in this build. Save the draft to keep it with the
                      lead, then copy it into your own email client. Mark the lead Contacted
                      yourself once it has actually gone out.
                    </p>
                    {leadLogs.length > 0 && (
                      <div className="text-xs text-dim space-y-1 pt-1 border-t border-ink/10">
                        <div className="micro">drafts for this lead</div>
                        {leadLogs.slice(0, 4).map((log) => (
                          <div key={log.id} className="truncate">
                            {log.sent_at?.slice(0, 16)} — {log.subject}{" "}
                            <span className="text-dim">({log.status})</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-dim">No email on file — Google doesn't publish them.</p>
                    {/* The old "Find Email on Their Site" button needed a
                        server-side fetch. Rather than a button that always
                        fails, state the limitation and the manual path. */}
                    <div className="border border-dim/30 rounded-lg px-3 py-2">
                      <div className="micro">{findEmailInfo.feature} — unavailable</div>
                      <p className="text-xs text-dim mt-1">{findEmailInfo.reason}</p>
                      <p className="text-xs text-ink/80 mt-1.5">{findEmailInfo.alternative}</p>
                    </div>
                    {selected.website_url && (
                      <a className="btn-ghost text-xs inline-block" href={selected.website_url} target="_blank" rel="noreferrer">
                        ↗ Open their site
                      </a>
                    )}
                    {msg && <span className="text-xs text-coral">{msg}</span>}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="glass p-10 text-center text-dim text-sm flex items-center justify-center lg:min-h-0">Pick a lead from the queue to start working.</div>
        )}
      </div>

      {/* Template manager */}
      <Modal open={manageOpen} onClose={() => { setManageOpen(false); setEditing(null); }} title="Email Templates" wide>
        {!editing ? (
          <div className="space-y-2">
            {templates.map((t) => (
              <div key={t.id} className="flex items-center justify-between bg-ink/5 rounded-lg px-3 py-2">
                <div>
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-dim">{KINDS.find(([k]) => k === t.kind)?.[1] || t.kind} · {t.subject}</div>
                </div>
                <div className="flex gap-1">
                  <button className="btn-ghost !py-1 text-xs" onClick={() => setEditing(t)}>Edit</button>
                  <button className="btn-ghost !py-1 text-xs text-coral" onClick={async () => { if (confirm(`Delete template "${t.name}"?`)) { await api.deleteTemplate(t.id); loadTemplates(); } }}>✕</button>
                </div>
              </div>
            ))}
            <button className="btn-primary" onClick={() => setEditing({ name: "", kind: "initial", subject: "", body: "" })}>+ New Template</button>
            <p className="text-xs text-dim">Placeholders: <code className="text-ember">{"{greeting} {business_name} {owner_name} {city} {industry} {rating} {reviews} {site_issue}"}</code></p>
            <p className="text-xs text-dim">{"{greeting}"} becomes "Hi FirstName," or "Hi Business team,". {"{site_issue}"} pulls the worst finding from the lead's website diagnostics, phrased for an owner.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Name"><input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Kind">
              <select className="input" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })}>
                {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </Field>
            <Field label="Subject"><input className="input" value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /></Field>
            <Field label="Body"><textarea className="input min-h-[160px]" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></Field>
            <div className="flex justify-between">
              <button className="btn-ghost" onClick={() => setEditing(null)}>Back</button>
              <button className="btn-primary" disabled={!editing.name}
                onClick={async () => {
                  if (editing.id) await api.updateTemplate(editing.id, editing);
                  else await api.createTemplate(editing);
                  setEditing(null);
                  loadTemplates();
                }}>
                Save Template
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Global history */}
      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Email History" wide>
        <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
          <table className="w-full">
            <thead>
              <tr><th className="th">Sent</th><th className="th">Lead</th><th className="th">Subject</th><th className="th">Status</th></tr>
            </thead>
            <tbody>
              {allLogs.map((log) => (
                <tr key={log.id}>
                  <td className="td text-dim text-xs">{log.sent_at}</td>
                  <td className="td">{log.business_name || "-"}</td>
                  <td className="td max-w-[280px]"><span className="block truncate" title={log.subject}>{log.subject}</span></td>
                  <td className="td"><span className={log.status === "sent" ? "text-mint" : log.status === "mock" ? "text-emberhi" : "text-coral"}>{log.status}</span></td>
                </tr>
              ))}
              {!allLogs.length && <tr><td className="td text-dim" colSpan={4}>No emails logged yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}
