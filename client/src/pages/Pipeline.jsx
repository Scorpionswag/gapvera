import { useState } from "react";
import { api, OUTREACH_STATUSES, STATUS_HEX } from "../api.js";
import { Score } from "../components/ui.jsx";
import LeadModal from "../components/LeadModal.jsx";

// The board gives its width to the stages that actually hold work. Empty
// stages collapse to a labelled rail and reopen the moment a drag starts, so
// every stage stays reachable without nine empty columns dominating the page.
export default function Pipeline({ leads, refresh }) {
  const [dragId, setDragId] = useState(null);
  const [overCol, setOverCol] = useState(null);
  const [selected, setSelected] = useState(null);

  async function drop(status) {
    setOverCol(null);
    if (!dragId) return;
    await api.updateLead(dragId, { outreach_status: status });
    setDragId(null);
    refresh();
  }

  const dragging = dragId !== null;
  const byStage = OUTREACH_STATUSES.map((status) => ({
    status,
    color: STATUS_HEX[status] || "#8fa3bc",
    cards: leads.filter((l) => l.outreach_status === status),
  }));
  const live = byStage.filter((s) => !["Closed", "Not Interested"].includes(s.status));
  const inPlay = live.reduce((n, s) => n + s.cards.length, 0);

  return (
    <div className="flex flex-col gap-4 lg:h-[calc(100vh-4rem)]">
      <div className="shrink-0">
        <h1 className="text-2xl font-bold">Pipeline</h1>
        <p className="text-sm text-dim">Drag a card to move the conversation. Empty stages open up while you drag.</p>
      </div>

      {/* Proportional funnel across every stage that holds someone */}
      <div className="glass p-4 shrink-0 flex items-center gap-5 flex-wrap">
        <div className="shrink-0">
          <div className="numeral text-3xl leading-none">{inPlay}</div>
          <div className="micro mt-1">in play</div>
        </div>
        <div className="flex-1 min-w-[240px]">
          <div className="flex h-2.5 rounded-full overflow-hidden bg-ink/10">
            {byStage.map(({ status, color, cards }) =>
              cards.length ? (
                <div
                  key={status}
                  title={`${status}: ${cards.length}`}
                  style={{ width: `${(cards.length / leads.length) * 100}%`, background: color, opacity: 0.72 }}
                />
              ) : null
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5">
            {byStage.map(({ status, color, cards }) =>
              cards.length ? (
                <span key={status} className="flex items-center gap-1.5 text-xs text-dim">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                  {status}
                  <span className="text-ink/80">{cards.length}</span>
                </span>
              ) : null
            )}
            {!leads.length && <span className="text-xs text-dim">No leads yet.</span>}
          </div>
        </div>
      </div>

      {/* Board */}
      <div className="flex gap-2 overflow-x-auto lg:overflow-x-visible pb-2 lg:pb-0 lg:flex-1 lg:min-h-0">
        {byStage.map(({ status, color, cards }) => {
          const collapsed = !cards.length && !dragging;
          const isOver = overCol === status;
          return (
            <div
              key={status}
              onDragOver={(e) => { e.preventDefault(); setOverCol(status); }}
              onDragLeave={() => setOverCol(null)}
              onDrop={() => drop(status)}
              className={`rounded-2xl flex flex-col min-h-[320px] lg:min-h-0 transition-all duration-300 ease-out
                ${collapsed ? "w-11 shrink-0 bg-ink/[0.03] border border-ink/5" : "w-56 shrink-0 lg:w-auto lg:flex-1 lg:min-w-0"}
                ${!collapsed && !isOver ? "bg-gradient-to-b from-[rgba(24,17,11,0.8)] to-[rgba(13,9,6,0.75)] border border-ink/10" : ""}
                ${isOver ? "border-2 border-dashed bg-ember/10" : ""}`}
              style={isOver ? { borderColor: color } : undefined}
            >
              {collapsed ? (
                // Rail: the stage stays visible and droppable, just out of the way
                <div className="flex-1 flex flex-col items-center justify-between py-3 gap-2">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, opacity: 0.8 }} />
                  <span
                    className="text-[10px] uppercase tracking-[0.18em] text-dim whitespace-nowrap rotate-180"
                    style={{ writingMode: "vertical-rl" }}
                  >
                    {status}
                  </span>
                  <span className="text-[10px] text-dim/60">0</span>
                </div>
              ) : (
                <>
                  <div className="px-3 pt-3 pb-2 shrink-0">
                    <div className="h-0.5 rounded-full mb-2.5" style={{ background: color, opacity: 0.75, boxShadow: `0 0 10px ${color}66` }} />
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/70 truncate" title={status}>
                        {status}
                      </span>
                      <span className="numeral text-sm shrink-0" style={{ color }}>{cards.length}</span>
                    </div>
                  </div>

                  <div className="space-y-2 overflow-y-auto flex-1 min-h-0 px-2.5 pb-2.5">
                    {cards.map((l) => (
                      <div
                        key={l.id}
                        draggable
                        onDragStart={() => setDragId(l.id)}
                        onDragEnd={() => { setDragId(null); setOverCol(null); }}
                        onClick={() => setSelected(l)}
                        title={`${l.business_name} · ${l.industry} · ${l.location}`}
                        className={`group bg-ink/[0.06] hover:bg-ink/[0.11] border border-ink/10 hover:border-ember/30 rounded-xl p-2.5
                          cursor-grab active:cursor-grabbing transition-all ${dragId === l.id ? "opacity-40" : ""}`}
                      >
                        <div className="text-xs font-medium leading-snug line-clamp-2 group-hover:text-emberhi transition-colors">
                          {l.business_name}
                        </div>
                        <div className="text-[11px] text-dim truncate mt-0.5">
                          {[l.industry, (l.location || "").split(",")[1]?.trim()].filter(Boolean).join(" · ")}
                        </div>
                        {/* wraps instead of forcing a min-content floor that
                            would stop narrow columns from shrinking */}
                        <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-0.5 mt-2 text-[11px]">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <Score value={l.lead_score} />
                            {l.website_status === "No Website" && (
                              <span className="text-[10px] text-mint/80 uppercase tracking-wider whitespace-nowrap">no site</span>
                            )}
                          </span>
                          {l.next_followup_date && <span className="text-dim whitespace-nowrap">{l.next_followup_date.slice(5)}</span>}
                        </div>
                      </div>
                    ))}
                    {!cards.length && (
                      <div className="h-full min-h-[80px] flex items-center justify-center text-[11px] text-dim/50 border border-dashed border-ink/10 rounded-xl">
                        drop here
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <LeadModal lead={selected} onClose={() => setSelected(null)} onSaved={(silent) => { refresh(); if (!silent) setSelected(null); }} />
    </div>
  );
}
