import { useEffect, useState } from "react";
import { api, daysFromNow } from "../api.js";
import { Badge } from "./ui.jsx";
import { openInvoice } from "../invoiceExport.js";

const STATUSES = ["Draft", "Sent", "Paid", "Void"];
const money = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const isPastDue = (inv) =>
  inv.status === "Sent" && inv.due_date && inv.due_date < new Date().toLocaleDateString("sv");

// Invoices for one client: list, create, edit line items, mark paid, print.
export default function InvoicePanel({ client, onChanged }) {
  const [invoices, setInvoices] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => { api.clientInvoices(client.id).then(setInvoices).catch(() => setInvoices([])); };
  useEffect(load, [client.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit(inv) {
    let items = [];
    try { items = JSON.parse(inv.line_items || "[]"); } catch { items = []; }
    setEditing({ ...inv, items: items.length ? items : [{ description: "", qty: 1, rate: 0 }] });
  }

  async function create() {
    setBusy(true);
    try {
      const inv = await api.createInvoice(client.id, { due_date: daysFromNow(14) });
      load();
      onChanged?.();
      startEdit(inv);
    } catch (err) {
      alert("Couldn't create the invoice: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  // Deposit + balance: two invoices, half each. Consumer Zelle send limits
  // often block a single large payment, so splitting is the practical default.
  async function createSplit() {
    const base = Number(client.contract_value) || 0;
    if (!base) {
      alert("Set a contract value on this client first, then the split can be calculated.");
      return;
    }
    const deposit = Math.round((base / 2) * 100) / 100;
    const balance = Math.round((base - deposit) * 100) / 100;
    const work = client.deliverables ? ` (${client.deliverables})` : "";
    setBusy(true);
    try {
      await api.createInvoice(client.id, {
        due_date: daysFromNow(7),
        line_items: [{ description: `Deposit, 50% to start${work}`, qty: 1, rate: deposit }],
        notes: "Work begins once the deposit clears.",
      });
      await api.createInvoice(client.id, {
        due_date: daysFromNow(30),
        line_items: [{ description: "Balance, 50% on completion", qty: 1, rate: balance }],
        notes: "Due when the site goes live and you have approved it.",
      });
      load();
      onChanged?.();
    } catch (err) {
      alert("Couldn't create the split: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api.updateInvoice(editing.id, {
        status: editing.status,
        issue_date: editing.issue_date,
        due_date: editing.due_date,
        tax_rate: Number(editing.tax_rate) || 0,
        payment_instructions: editing.payment_instructions,
        notes: editing.notes,
        line_items: editing.items.map((i) => ({ description: i.description, qty: Number(i.qty) || 0, rate: Number(i.rate) || 0 })),
      });
      setEditing(null);
      load();
      onChanged?.();
    } catch (err) {
      alert("Couldn't save the invoice: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(inv, status) {
    try {
      await api.updateInvoice(inv.id, { status });
      load();
      onChanged?.();
    } catch (err) {
      alert("Couldn't update the invoice: " + err.message);
    }
  }

  const editTotal = editing
    ? editing.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0) * (1 + (Number(editing.tax_rate) || 0) / 100)
    : 0;

  if (editing) {
    return (
      <div className="space-y-3 border border-ember/20 rounded-xl p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{editing.number}</span>
          <button className="btn-ghost !py-1 text-xs" onClick={() => setEditing(null)}>Back to list</button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <label className="block"><span className="label">Status</span>
            <select className="input" value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
              {STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="block"><span className="label">Issued</span>
            <input type="date" className="input" value={editing.issue_date || ""} onChange={(e) => setEditing({ ...editing, issue_date: e.target.value })} />
          </label>
          <label className="block"><span className="label">Due</span>
            <input type="date" className="input" value={editing.due_date || ""} onChange={(e) => setEditing({ ...editing, due_date: e.target.value })} />
          </label>
          <label className="block"><span className="label">Tax %</span>
            <input type="number" step="0.01" className="input" value={editing.tax_rate || 0} onChange={(e) => setEditing({ ...editing, tax_rate: e.target.value })} />
          </label>
        </div>

        <div className="space-y-1">
          <span className="label">Line items</span>
          <div className="flex gap-1.5 text-[10px] uppercase tracking-[0.14em] text-dim">
            <span className="flex-1">Description</span>
            <span className="w-16 shrink-0">Qty</span>
            <span className="w-24 shrink-0">Price</span>
            <span className="w-20 shrink-0 text-right">Amount</span>
            <span className="w-5 shrink-0" />
          </div>
          {editing.items.map((item, idx) => (
            <div key={idx} className="flex gap-1.5">
              <input className="input flex-1" placeholder="Description" value={item.description}
                onChange={(e) => { const items = [...editing.items]; items[idx] = { ...item, description: e.target.value }; setEditing({ ...editing, items }); }} />
              <input type="number" className="input !w-16" placeholder="Qty" value={item.qty}
                onChange={(e) => { const items = [...editing.items]; items[idx] = { ...item, qty: e.target.value }; setEditing({ ...editing, items }); }} />
              <input type="number" step="0.01" className="input !w-24" placeholder="Rate" value={item.rate}
                onChange={(e) => { const items = [...editing.items]; items[idx] = { ...item, rate: e.target.value }; setEditing({ ...editing, items }); }} />
              <span className="text-xs text-dim w-20 pt-2 text-right shrink-0">{money((Number(item.qty) || 0) * (Number(item.rate) || 0))}</span>
              <button className="text-coral opacity-50 hover:opacity-100 px-1" title="Remove line"
                onClick={() => setEditing({ ...editing, items: editing.items.filter((_, i) => i !== idx) })}>✕</button>
            </div>
          ))}
          <button className="btn-ghost !py-1 text-xs" onClick={() => setEditing({ ...editing, items: [...editing.items, { description: "", qty: 1, rate: 0 }] })}>
            + Add line
          </button>
        </div>

        <label className="block"><span className="label">How to pay (appears on the invoice)</span>
          <textarea className="input min-h-[70px]" value={editing.payment_instructions || ""}
            placeholder={"e.g. Zelle to 555-555-0100\nChecks payable to Your Name\nNet 14"}
            onChange={(e) => setEditing({ ...editing, payment_instructions: e.target.value })} />
        </label>
        <label className="block"><span className="label">Notes</span>
          <input className="input" value={editing.notes || ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
        </label>

        <div className="flex items-center justify-between">
          <span className="text-sm">Total <span className="numeral text-emberhi ml-1">{money(editTotal)}</span></span>
          <div className="flex gap-2">
            <button className="btn-ghost text-xs" onClick={() => openInvoice({ ...editing, line_items: JSON.stringify(editing.items) }, client)}>⎙ Preview</button>
            <button className="btn-primary text-xs" disabled={busy} onClick={save}>Save Invoice</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {invoices.map((inv) => (
        <div key={inv.id} className="flex items-center justify-between gap-2 bg-ink/5 rounded-lg px-3 py-2 text-sm">
          <span className="flex items-center gap-2 min-w-0">
            <span className="font-medium">{inv.number}</span>
            <Badge>{inv.status}</Badge>
            {isPastDue(inv) && <span className="text-xs text-coral font-medium">past due</span>}
            <span className="numeral">{money(inv.total)}</span>
            {inv.due_date && !isPastDue(inv) && <span className="text-xs text-dim">due {inv.due_date}</span>}
          </span>
          <span className="flex items-center gap-1 shrink-0">
            {inv.status === "Draft" && (
              <button className="btn-ghost !py-0.5 !px-2 text-xs" title="Mark as sent once it's emailed" onClick={() => setStatus(inv, "Sent")}>Mark sent</button>
            )}
            {(inv.status === "Sent" || isPastDue(inv)) && (
              <button className="btn-ghost !py-0.5 !px-2 text-xs" title="Mark as paid" onClick={() => setStatus(inv, "Paid")}>Mark paid</button>
            )}
            {inv.status === "Sent" && (
              <button className="btn-ghost !py-0.5 !px-2 text-xs" title="Cancel this invoice; its number is never reused" onClick={() => setStatus(inv, "Void")}>Void</button>
            )}
            <button className="btn-ghost !py-0.5 !px-2 text-xs" onClick={() => openInvoice(inv, client)}>⎙</button>
            <button className="btn-ghost !py-0.5 !px-2 text-xs" onClick={() => startEdit(inv)}>Edit</button>
            {(inv.status === "Draft" || inv.status === "Void") && (
              <button className="text-coral opacity-50 hover:opacity-100 px-1" title="Delete (Drafts and Voids only)"
                onClick={async () => {
                  if (!confirm(`Delete ${inv.number}?`)) return;
                  try { await api.deleteInvoice(inv.id); load(); onChanged?.(); }
                  catch (err) { alert("Couldn't delete: " + err.message); }
                }}>✕</button>
            )}
          </span>
        </div>
      ))}
      {!invoices.length && <p className="text-xs text-dim">No invoices yet. Creating one pre-fills from the contract value and deliverables.</p>}
      <div className="flex gap-2">
        <button className="btn-ghost text-xs" disabled={busy} onClick={create}>{busy ? "Creating..." : "+ New Invoice"}</button>
        <button className="btn-ghost text-xs" disabled={busy} title="Two invoices: half to start, half on completion"
          onClick={createSplit}>+ Deposit + Balance (50/50)</button>
      </div>
    </div>
  );
}
