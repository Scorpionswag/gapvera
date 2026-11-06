import { useEffect, useRef, useState } from "react";
import { api, PROJECT_STATUSES } from "../api.js";
import { Badge, Modal, Field, StatCard } from "../components/ui.jsx";
import { DocLink } from "../components/DocLink.jsx";
import InvoicePanel from "../components/InvoicePanel.jsx";

const fmtSize = (n) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

export default function Clients() {
  const [clients, setClients] = useState([]);
  const [editing, setEditing] = useState(null);
  const [docs, setDocs] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef(null);
  const load = () => { api.clients().then(setClients); };
  useEffect(load, []);

  useEffect(() => {
    if (editing?.id) api.clientDocs(editing.id).then(setDocs).catch(() => setDocs([]));
    else setDocs([]);
  }, [editing?.id]);

  async function onFilesPicked(e) {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    try {
      setDocs(await api.uploadDocs(editing.id, files));
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  const totalValue = clients.reduce((s, c) => s + (c.contract_value || 0), 0);
  const active = clients.filter((c) => !["Completed", "On Hold"].includes(c.project_status)).length;

  const set = (k) => (e) => setEditing({ ...editing, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Clients</h1>

      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Clients" value={clients.length} />
        <StatCard label="Active Projects" value={active} />
        <StatCard label="Total Contract Value" value={`$${totalValue.toLocaleString()}`} />
      </div>

      <div className="glass p-4 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Business</th><th className="th">Status</th><th className="th">Value</th>
              <th className="th">Start</th><th className="th">Due</th><th className="th">Deliverables</th><th className="th" />
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="hover:bg-ink/5 cursor-pointer" onClick={() => setEditing(c)}>
                <td className="td font-medium">{c.business_name}<div className="text-xs text-dim">{c.owner_name} · {c.email || c.phone}</div></td>
                <td className="td"><Badge>{c.project_status}</Badge></td>
                <td className="td">${(c.contract_value || 0).toLocaleString()}</td>
                <td className="td text-dim">{c.start_date || "-"}</td>
                <td className="td text-dim">{c.due_date || "-"}</td>
                <td className="td text-dim max-w-[240px] truncate">{c.deliverables}</td>
                <td className="td">
                  <button
                    className="btn-ghost !py-1 text-xs text-coral"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (confirm(`Delete client "${c.business_name}"?`)) { await api.deleteClient(c.id); load(); }
                    }}
                  >✕</button>
                </td>
              </tr>
            ))}
            {!clients.length && <tr><td className="td text-dim" colSpan={7}>No clients yet — convert a lead from the Leads page.</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.business_name || ""} wide>
        {editing && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Business Name"><input className="input" value={editing.business_name || ""} onChange={set("business_name")} /></Field>
            <Field label="Owner"><input className="input" value={editing.owner_name || ""} onChange={set("owner_name")} /></Field>
            <Field label="Phone"><input className="input" value={editing.phone || ""} onChange={set("phone")} /></Field>
            <Field label="Email"><input className="input" value={editing.email || ""} onChange={set("email")} /></Field>
            <Field label="Project Status">
              <select className="input" value={editing.project_status} onChange={set("project_status")}>
                {PROJECT_STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Contract Value ($)"><input type="number" className="input" value={editing.contract_value || 0} onChange={set("contract_value")} /></Field>
            <Field label="Start Date"><input type="date" className="input" value={editing.start_date || ""} onChange={set("start_date")} /></Field>
            <Field label="Due Date"><input type="date" className="input" value={editing.due_date || ""} onChange={set("due_date")} /></Field>
            <div className="md:col-span-2"><Field label="Deliverables"><textarea className="input" value={editing.deliverables || ""} onChange={set("deliverables")} /></Field></div>
            <div className="md:col-span-2"><Field label="Website Adjustments"><textarea className="input" value={editing.website_adjustments || ""} onChange={set("website_adjustments")} /></Field></div>
            <div className="md:col-span-2"><Field label="Notes"><textarea className="input" value={editing.notes || ""} onChange={set("notes")} /></Field></div>

            <div className="md:col-span-2 space-y-2 pt-2 border-t border-ink/10">
              <label className="label !mb-0">Invoices</label>
              <InvoicePanel client={editing} onChanged={load} />
            </div>

            <div className="md:col-span-2 space-y-2 pt-2 border-t border-ink/10">
              <div className="flex items-center justify-between">
                <label className="label !mb-0">Documents ({docs.length})</label>
                <button type="button" className="btn-ghost text-xs" disabled={uploading} onClick={() => fileInput.current?.click()}>
                  {uploading ? "Uploading..." : "+ Add Files"}
                </button>
                <input ref={fileInput} type="file" multiple className="hidden" onChange={onFilesPicked} />
              </div>
              {docs.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 bg-ink/5 rounded-lg px-3 py-1.5 text-sm">
                  <DocLink doc={d} className="truncate text-ember hover:underline">
                    {d.filename}
                  </DocLink>
                  <span className="flex items-center gap-2 shrink-0 text-xs text-dim">
                    {fmtSize(d.size)} · {d.uploaded_at?.slice(0, 10)}
                    <DocLink doc={d} download className="btn-ghost !py-0.5 !px-2" title="Download">
                      ↓
                    </DocLink>
                    <button className="text-coral opacity-50 hover:opacity-100" title="Delete file"
                      onClick={async () => {
                        if (!confirm(`Delete "${d.filename}"?`)) return;
                        await api.deleteDoc(d.id);
                        setDocs(await api.clientDocs(editing.id));
                      }}>✕</button>
                  </span>
                </div>
              ))}
              {!docs.length && <p className="text-xs text-dim">No documents yet. Contracts, mockups, invoices, site assets, anything.</p>}
            </div>

            <div className="md:col-span-2 flex justify-end">
              <button
                className="btn-primary"
                onClick={async () => {
                  await api.updateClient(editing.id, { ...editing, contract_value: Number(editing.contract_value) || 0 });
                  setEditing(null);
                  load();
                }}
              >Save</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
