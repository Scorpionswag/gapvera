import { useState } from "react";
import { meta } from "../api.js";
import { Badge, Score } from "../components/ui.jsx";
import LeadModal from "../components/LeadModal.jsx";

export default function FollowUps({ leads, refresh }) {
  const [selected, setSelected] = useState(null);
  const today = new Date().toISOString().slice(0, 10);

  const withDates = leads
    .filter((l) => l.next_followup_date && !["Closed", "Not Interested", "Booked"].includes(l.outreach_status))
    .sort((a, b) => a.next_followup_date.localeCompare(b.next_followup_date));

  const overdue = withDates.filter((l) => l.next_followup_date < today);
  const dueToday = withDates.filter((l) => l.next_followup_date === today);
  const upcoming = withDates.filter((l) => l.next_followup_date > today);

  const Section = ({ title, items, tone }) => (
    <div className="glass p-4">
      <h2 className={`font-semibold mb-3 ${tone}`}>{title} <span className="text-dim text-sm font-normal">({items.length})</span></h2>
      {items.length ? (
        <div className="space-y-2">
          {items.map((l) => (
            <div key={l.id} className="flex items-center justify-between bg-ink/5 hover:bg-ink/10 rounded-lg px-3 py-2 cursor-pointer" onClick={() => setSelected(l)}>
              <div>
                <div className="text-sm font-medium">{l.business_name}</div>
                <div className="text-xs text-dim">{meta(l.owner_name, l.phone || l.email, l.industry)}</div>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Badge>{l.outreach_status}</Badge>
                <Score value={l.lead_score} />
                <span className={`text-xs ${tone}`}>{l.next_followup_date}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-dim">Nothing here.</p>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Follow-Ups</h1>
      <Section title="Overdue" items={overdue} tone="text-coral" />
      <Section title="Due Today" items={dueToday} tone="text-emberhi" />
      <Section title="Upcoming" items={upcoming} tone="text-ember" />
      <LeadModal lead={selected} onClose={() => setSelected(null)} onSaved={(silent) => { refresh(); if (!silent) setSelected(null); }} />
    </div>
  );
}
