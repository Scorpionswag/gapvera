import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, daysFromNow } from "../api.js";
import { StatCard, Badge, Score, SortHeader, sortRows } from "../components/ui.jsx";
import LeadModal from "../components/LeadModal.jsx";

export default function Dashboard({ leads, refresh }) {
  const [sort, setSort] = useState({ field: "lead_score", dir: "desc" });
  const [selected, setSelected] = useState(null);
  const [clients, setClients] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.clients().then(setClients).catch(() => {});
  }, [leads]);

  const count = (s) => leads.filter((l) => l.outreach_status === s).length;
  const contacted = leads.filter((l) => l.outreach_status !== "Not Contacted").length;
  const wonRevenue = clients.reduce((s, c) => s + (c.contract_value || 0), 0);
  const rows = sortRows(leads, sort).slice(0, 10);

  // Today's Actions: due/overdue follow-ups first, then the best never-contacted
  // leads, so the day always starts with a concrete call list.
  const today = new Date().toISOString().slice(0, 10);
  const dead = ["Closed", "Not Interested", "Booked"];
  const dueFollowups = leads
    .filter((l) => l.next_followup_date && l.next_followup_date <= today && !dead.includes(l.outreach_status))
    .sort((a, b) => a.next_followup_date.localeCompare(b.next_followup_date))
    .map((l) => ({ lead: l, reason: l.next_followup_date < today ? `Follow-up overdue (${l.next_followup_date})` : "Follow-up due today", tone: l.next_followup_date < today ? "text-coral" : "text-emberhi" }));
  const fresh = leads
    .filter((l) => l.outreach_status === "Not Contacted")
    .sort((a, b) => b.lead_score - a.lead_score)
    .slice(0, 3)
    .map((l) => ({ lead: l, reason: `Never contacted — score ${l.lead_score}`, tone: "text-ember" }));
  const actions = [...dueFollowups, ...fresh].slice(0, 8);

  function composeTo(lead) {
    localStorage.setItem("compose_lead_id", String(lead.id));
    navigate("/outreach");
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Total Leads" value={leads.length} />
        <StatCard label="Contacted" value={contacted} sub={`${leads.length ? Math.round((contacted / leads.length) * 100) : 0}% of leads`} />
        <StatCard label="Interested" value={count("Interested") + count("Replied")} sub="replied + interested" />
        <StatCard label="Booked" value={count("Booked")} />
        <StatCard label="Won Revenue" value={`$${wonRevenue.toLocaleString()}`} sub={`${clients.length} client${clients.length === 1 ? "" : "s"}`} />
      </div>

      <div className="glass p-4">
        <h2 className="font-semibold mb-3">Today's Actions <span className="text-dim text-sm font-normal">({actions.length})</span></h2>
        {actions.length ? (
          <div className="space-y-2">
            {actions.map(({ lead, reason, tone }) => (
              <div key={lead.id} className="flex items-center justify-between flex-wrap gap-2 bg-ink/5 rounded-lg px-3 py-2">
                <div className="cursor-pointer" onClick={() => setSelected(lead)}>
                  <span className="text-sm font-medium">{lead.business_name}</span>
                  <span className={`text-xs ml-3 ${tone}`}>{reason}</span>
                  <div className="text-xs text-dim">{lead.owner_name} · {lead.industry} · <Badge>{lead.outreach_status}</Badge></div>
                </div>
                <div className="flex gap-1">
                  {lead.phone && <a className="btn-ghost !py-1 text-xs" href={`tel:${lead.phone}`}>Call</a>}
                  {lead.email && <button className="btn-ghost !py-1 text-xs" onClick={() => composeTo(lead)}>Email</button>}
                  {lead.next_followup_date && (
                    <button className="btn-ghost !py-1 text-xs" title="Push follow-up to tomorrow"
                      onClick={async () => { await api.updateLead(lead.id, { next_followup_date: daysFromNow(1) }); refresh(); }}>
                      Snooze
                    </button>
                  )}
                  <button className="btn-ghost !py-1 text-xs" onClick={() => setSelected(lead)}>Open</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-dim">Clear — no follow-ups due and no uncontacted leads. Go scrape some.</p>
        )}
      </div>

      <div className="glass p-4 overflow-x-auto">
        <h2 className="font-semibold mb-3">Top Leads</h2>
        <table className="w-full">
          <thead>
            <tr>
              <SortHeader label="Business" field="business_name" sort={sort} setSort={setSort} />
              <SortHeader label="Score" field="lead_score" sort={sort} setSort={setSort} />
              <SortHeader label="Status" field="outreach_status" sort={sort} setSort={setSort} />
              <SortHeader label="Website" field="website_status" sort={sort} setSort={setSort} />
              <SortHeader label="Rating" field="star_rating" sort={sort} setSort={setSort} />
              <SortHeader label="Reviews" field="review_count" sort={sort} setSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className="hover:bg-ink/5 cursor-pointer" onClick={() => setSelected(l)}>
                <td className="td font-medium max-w-[280px]">
                  <span className="block truncate" title={l.business_name}>{l.business_name}</span>
                  <div className="text-xs text-dim truncate" title={l.location}>{l.location}</div>
                </td>
                <td className="td"><Score value={l.lead_score} /></td>
                <td className="td"><Badge>{l.outreach_status}</Badge></td>
                <td className="td text-dim">{l.website_status}</td>
                <td className="td">{l.star_rating || "-"}</td>
                <td className="td">{l.review_count}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td className="td text-dim" colSpan={6}>No leads yet — scrape some or add them on the Leads page.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <LeadModal lead={selected} onClose={() => setSelected(null)} onSaved={(silent) => { refresh(); if (!silent) setSelected(null); }} />
    </div>
  );
}
