import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, PROJECT_STATUSES, daysFromNow } from "../api.js";
import { Badge, StatCard } from "../components/ui.jsx";
import { DocLink } from "../components/DocLink.jsx";

// Ledger: the client-side twin of the Dashboard. 01 watches the leads coming
// in; this page watches the work and money going out — projects, deadlines,
// contract value, and the paper trail.
export default function Ledger() {
  const [clients, setClients] = useState([]);
  const [docs, setDocs] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.clients().then(setClients).catch(() => {});
    api.recentDocs().then(setDocs).catch(() => {});
    api.invoices().then(setInvoices).catch(() => {});
  }, []);

  const today = daysFromNow(0);
  const soon = daysFromNow(7);

  const stats = useMemo(() => {
    const active = clients.filter((c) => ["Discovery", "In Progress", "Review"].includes(c.project_status));
    const completed = clients.filter((c) => c.project_status === "Completed");
    const overdue = clients.filter((c) => c.due_date && c.due_date < today && c.project_status !== "Completed");
    const unpaid = invoices.filter((i) => i.status === "Sent");
    return {
      active: active.length,
      inFlight: active.reduce((s, c) => s + (c.contract_value || 0), 0),
      completed: completed.length,
      completedValue: completed.reduce((s, c) => s + (c.contract_value || 0), 0),
      overdue: overdue.length,
      collected: invoices.filter((i) => i.status === "Paid").reduce((s, i) => s + (i.total || 0), 0),
      outstanding: unpaid.reduce((s, i) => s + (i.total || 0), 0),
      outstandingCount: unpaid.length,
      lateInvoices: unpaid.filter((i) => i.due_date && i.due_date < today),
    };
  }, [clients, invoices, today]);

  const deadlines = useMemo(
    () =>
      clients
        .filter((c) => c.due_date && c.project_status !== "Completed")
        .sort((a, b) => a.due_date.localeCompare(b.due_date)),
    [clients]
  );

  const tone = (due) => (due < today ? "text-coral" : due <= soon ? "text-emberhi" : "text-dim");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Ledger</h1>
      <p className="text-sm text-dim">The delivery side: projects, deadlines, and money. Click anything to work it on the Clients page.</p>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Active Projects" value={stats.active} sub="discovery, build, review" />
        <StatCard label="Value in Flight" value={`$${stats.inFlight.toLocaleString()}`} sub="active contracts" />
        <StatCard label="Outstanding" value={`$${stats.outstanding.toLocaleString()}`} sub={`${stats.outstandingCount} unpaid invoice${stats.outstandingCount === 1 ? "" : "s"}`} />
        <StatCard label="Collected" value={`$${stats.collected.toLocaleString()}`} sub="invoices marked paid" />
        <StatCard label="Late" value={stats.overdue + stats.lateInvoices.length} sub={stats.overdue + stats.lateInvoices.length ? "projects + invoices" : "all on schedule"} />
      </div>

      {stats.lateInvoices.length > 0 && (
        <div className="glass p-4 border border-coral/25">
          <h2 className="font-semibold mb-3 text-coral">Invoices Past Due</h2>
          <div className="space-y-1">
            {stats.lateInvoices.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 bg-ink/5 hover:bg-ink/10 rounded-lg px-3 py-2 text-sm cursor-pointer" onClick={() => navigate("/clients")}>
                <span className="truncate"><span className="font-medium">{i.number}</span> <span className="text-dim">{i.business_name}</span></span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="numeral">${(i.total || 0).toLocaleString()}</span>
                  <span className="text-xs text-coral">due {i.due_date}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="glass p-4">
        <h2 className="font-semibold mb-3">Deadlines</h2>
        {deadlines.length ? (
          <div className="space-y-1">
            {deadlines.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 bg-ink/5 hover:bg-ink/10 rounded-lg px-3 py-2 cursor-pointer" onClick={() => navigate("/clients")}>
                <div className="min-w-0">
                  <span className="text-sm font-medium truncate block">{c.business_name}</span>
                  <span className="text-xs text-dim truncate block">{c.deliverables || "no deliverables listed"}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-sm">
                  <Badge>{c.project_status}</Badge>
                  <span className="numeral">${(c.contract_value || 0).toLocaleString()}</span>
                  <span className={`text-xs w-24 text-right ${tone(c.due_date)}`}>
                    {c.due_date < today ? `overdue ${c.due_date}` : `due ${c.due_date}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-dim">No open due dates. Set them on the Clients page so this board can chase you.</p>
        )}
      </div>

      <div className="glass p-4 overflow-x-auto">
        <h2 className="font-semibold mb-3">Projects by Stage</h2>
        <div className="flex gap-3 min-w-max">
          {PROJECT_STATUSES.map((status) => {
            const group = clients.filter((c) => c.project_status === status);
            return (
              <div key={status} className="w-52 shrink-0">
                <div className="flex items-center justify-between mb-2">
                  <span className="micro">{status}</span>
                  <span className="text-xs bg-ink/10 rounded-full px-2 py-0.5">{group.length}</span>
                </div>
                <div className="space-y-1.5">
                  {group.map((c) => (
                    <div key={c.id} className="bg-ink/5 hover:bg-ink/10 border border-ink/10 rounded-lg px-3 py-2 cursor-pointer" onClick={() => navigate("/clients")}>
                      <div className="text-sm font-medium truncate">{c.business_name}</div>
                      <div className="flex justify-between text-xs text-dim mt-0.5">
                        <span className="numeral">${(c.contract_value || 0).toLocaleString()}</span>
                        {c.due_date && <span className={tone(c.due_date)}>{c.due_date.slice(5)}</span>}
                      </div>
                    </div>
                  ))}
                  {!group.length && <div className="text-xs text-dim/60 px-1">empty</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="glass p-4">
        <h2 className="font-semibold mb-3">Recent Documents</h2>
        {docs.length ? (
          <div className="space-y-1">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 bg-ink/5 rounded-lg px-3 py-1.5 text-sm">
                <DocLink doc={d} className="text-ember hover:underline truncate">
                  {d.filename}
                </DocLink>
                <span className="text-xs text-dim shrink-0">{d.business_name || "(deleted client)"} · {d.uploaded_at?.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-dim">Nothing filed yet. Documents added to clients show up here.</p>
        )}
      </div>
    </div>
  );
}
