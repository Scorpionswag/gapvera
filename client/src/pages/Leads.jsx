import { useMemo, useState } from "react";
import { api, OUTREACH_STATUSES, WEBSITE_STATUSES, meta } from "../api.js";
import { Badge, Score, Stars, SortHeader, sortRows, Modal, Field } from "../components/ui.jsx";
import LeadModal from "../components/LeadModal.jsx";

export default function Leads({ leads, refresh }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [sort, setSort] = useState({ field: "lead_score", dir: "desc" });
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newLead, setNewLead] = useState({ business_name: "", owner_name: "", phone: "", email: "", location: "", industry: "" });
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const rows = useMemo(() => {
    const q = search.toLowerCase();
    let out = leads.filter(
      (l) =>
        (!q || [l.business_name, l.owner_name, l.location, l.industry, l.email].join(" ").toLowerCase().includes(q)) &&
        (!statusFilter || l.outreach_status === statusFilter) &&
        (!siteFilter || l.website_status === siteFilter)
    );
    return sortRows(out, sort);
  }, [leads, search, statusFilter, siteFilter, sort]);

  function toggleOne(id) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const allChecked = rows.length > 0 && rows.every((l) => checkedIds.has(l.id));
    setCheckedIds(allChecked ? new Set() : new Set(rows.map((l) => l.id)));
  }

  async function bulkDelete() {
    if (!confirm(`Delete ${checkedIds.size} lead(s)? Their email history stays in the global log.`)) return;
    setBulkBusy(true);
    try {
      for (const id of checkedIds) await api.deleteLead(id);
      setCheckedIds(new Set());
      refresh();
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkStatus(status) {
    if (!status) return;
    setBulkBusy(true);
    try {
      for (const id of checkedIds) await api.updateLead(id, { outreach_status: status });
      setCheckedIds(new Set());
      refresh();
    } finally {
      setBulkBusy(false);
    }
  }

  async function quickConvert(lead) {
    if (!confirm(`Convert "${lead.business_name}" to a client?`)) return;
    await api.convertLead(lead.id, {});
    refresh();
  }

  function exportCsv() {
    const cols = ["business_name", "owner_name", "phone", "email", "location", "industry", "website_status", "website_url", "outreach_status", "outreach_channel", "last_contact_date", "next_followup_date", "star_rating", "review_count", "lead_score", "notes"];
    const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const csv = [cols.join(","), ...rows.map((l) => cols.map((c) => esc(l[c])).join(","))].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Leads <span className="text-sm text-dim font-normal">({rows.length})</span></h1>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
          <button className="btn-primary" onClick={() => setAdding(true)}>+ Add Lead</button>
        </div>
      </div>

      <div className="glass p-3 flex flex-wrap gap-2 items-center">
        <input className="input md:max-w-xs" placeholder="Search business, owner, city..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input md:!w-auto md:min-w-[200px]" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All Outreach Statuses</option>
          {OUTREACH_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className="input md:!w-auto md:min-w-[180px]" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
          <option value="">All Website Statuses</option>
          {WEBSITE_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>

      {checkedIds.size > 0 && (
        <div className="glass p-3 flex flex-wrap items-center gap-3 border border-ember/25">
          <span className="text-sm"><span className="numeral text-emberhi">{checkedIds.size}</span> selected</span>
          <select className="input !w-auto text-sm" defaultValue="" disabled={bulkBusy} onChange={(e) => { bulkStatus(e.target.value); e.target.value = ""; }}>
            <option value="" disabled>Set status to...</option>
            {OUTREACH_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="btn-danger text-sm" disabled={bulkBusy} onClick={bulkDelete}>{bulkBusy ? "Working..." : `Delete ${checkedIds.size}`}</button>
          <button className="btn-ghost text-sm" disabled={bulkBusy} onClick={() => setCheckedIds(new Set())}>Clear selection</button>
        </div>
      )}

      <div className="glass p-4 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">
                <input type="checkbox" checked={rows.length > 0 && rows.every((l) => checkedIds.has(l.id))} onChange={toggleAll} />
              </th>
              <SortHeader label="Business" field="business_name" sort={sort} setSort={setSort} />
              <SortHeader label="Score" field="lead_score" sort={sort} setSort={setSort} />
              <SortHeader label="Status" field="outreach_status" sort={sort} setSort={setSort} />
              <SortHeader label="Website" field="website_status" sort={sort} setSort={setSort} />
              <SortHeader label="Rating" field="star_rating" sort={sort} setSort={setSort} />
              <SortHeader label="Reviews" field="review_count" sort={sort} setSort={setSort} />
              <SortHeader label="Next Follow-Up" field="next_followup_date" sort={sort} setSort={setSort} />
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className="hover:bg-ink/5 cursor-pointer" onClick={() => setSelected(l)}>
                <td className="td" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={checkedIds.has(l.id)} onChange={() => toggleOne(l.id)} />
                </td>
                <td className="td font-medium max-w-[300px]">
                  <span className="block truncate" title={l.business_name}>{l.business_name}</span>
                  <div className="text-xs text-dim truncate" title={meta(l.owner_name, l.location, l.industry)}>
                    {meta(l.owner_name, l.location, l.industry)}
                    {l.phone && <> · <a className="text-ember hover:underline" href={`tel:${l.phone}`} onClick={(e) => e.stopPropagation()}>{l.phone}</a></>}
                  </div>
                </td>
                <td className="td"><Score value={l.lead_score} /></td>
                <td className="td"><Badge>{l.outreach_status}</Badge></td>
                <td className="td text-dim">
                  {l.website_url ? (
                    <a className="text-ember hover:underline" href={l.website_url} target="_blank" rel="noreferrer" title={l.website_url} onClick={(e) => e.stopPropagation()}>
                      {l.website_status} ↗
                    </a>
                  ) : (
                    l.website_status
                  )}
                </td>
                <td className="td"><Stars rating={l.star_rating} /></td>
                <td className="td">{l.review_count}</td>
                <td className="td text-dim">{l.next_followup_date || "-"}</td>
                <td className="td">
                  <button className="btn-ghost !py-1 text-xs" onClick={(e) => { e.stopPropagation(); quickConvert(l); }}>
                    → Client
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td className="td text-dim" colSpan={9}>No leads match.</td></tr>}
          </tbody>
        </table>
      </div>

      <LeadModal lead={selected} onClose={() => setSelected(null)} onSaved={(silent) => { refresh(); if (!silent) setSelected(null); }} />

      <Modal open={adding} onClose={() => setAdding(false)} title="Add Lead">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[
            ["business_name", "Business Name"], ["owner_name", "Owner"], ["phone", "Phone"],
            ["email", "Email"], ["location", "Location"], ["industry", "Industry"],
          ].map(([k, label]) => (
            <Field key={k} label={label}>
              <input className="input" value={newLead[k]} onChange={(e) => setNewLead({ ...newLead, [k]: e.target.value })} />
            </Field>
          ))}
          <div className="md:col-span-2 flex justify-end">
            <button
              className="btn-primary"
              disabled={!newLead.business_name}
              onClick={async () => {
                await api.createLead(newLead);
                setNewLead({ business_name: "", owner_name: "", phone: "", email: "", location: "", industry: "" });
                setAdding(false);
                refresh();
              }}
            >
              Create
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
