import { BRAND } from "./brand.js";
// Renders an invoice as a clean, light, print-ready page. Same deliverable
// rules as the audit report: no links, no GapVera branding, signed as you.

const esc = (s) =>
  String(s ?? "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const money = (n) =>
  `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Letterhead identity — matches the audit report. Logo image if BRAND.logo is
// set, otherwise a monogram of the sender's initials in a brand-rust badge.
const initials = (name) => {
  const words = (name || "").split(/\s+/).filter(Boolean);
  // A one-word CamelCase brand ("GapVera") should read "GV", not "G". Requires a
  // lowercase tail so acronyms ("ACME", "3M") stay single-letter as before.
  const camel = (words[0] || "").match(/[A-Z][a-z]+/g);
  const parts = words.length > 1 ? words : camel && camel.length > 1 ? camel : words;
  return parts.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "•";
};

const logoBlock = (name, px = 46) =>
  BRAND.logo
    ? `<img class="lh-img" src="${esc(BRAND.logo)}" alt="${esc(name)}" style="height:${px}px">`
    : `<div class="monogram" style="width:${px}px;height:${px}px">${esc(initials(name))}</div>`;

export function openInvoice(invoice, client, from = {}) {
  let items = [];
  try { items = JSON.parse(invoice.line_items || "[]"); } catch { items = []; }
  if (!Array.isArray(items)) items = [];

  const sub = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
  const taxRate = Number(invoice.tax_rate) || 0;
  const tax = sub * (taxRate / 100);
  const total = sub + tax;
  const paid = invoice.status === "Paid";
  const fromName = from.name || BRAND.name;
  const fromLoc = from.location || BRAND.location;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(invoice.number)} - ${esc(client.business_name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #16233b; background: #fff; max-width: 720px; margin: 0 auto; padding: 48px 32px; line-height: 1.5; }
  .toolbar { position: fixed; top: 0; left: 0; right: 0; background: #16233b; color: #fff; padding: 10px 16px; font-family: Arial, sans-serif; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
  .toolbar button { background: #fff; color: #16233b; border: 0; padding: 6px 14px; font-weight: bold; cursor: pointer; border-radius: 4px; }
  .page { margin-top: 40px; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #16233b; padding-bottom: 14px; }
  h1 { font-size: 30px; font-weight: normal; letter-spacing: 0.02em; }
  .meta { font-family: Arial, sans-serif; font-size: 12px; text-align: right; color: #3a4658; line-height: 1.7; }
  .meta strong { color: #16233b; }
  .paidstamp { display: inline-block; border: 2px solid #16a34a; color: #16a34a; font-family: Arial, sans-serif; font-size: 12px; font-weight: bold; letter-spacing: 0.12em; padding: 3px 10px; margin-top: 6px; }
  .letterhead { display: flex; align-items: center; gap: 14px; }
  .monogram { background: #c24b2e; color: #fff; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-family: Arial, sans-serif; font-weight: bold; font-size: 17px; letter-spacing: 0.03em; }
  .lh-img { width: auto; display: block; }
  .lh-name { font-size: 20px; color: #16233b; line-height: 1.1; }
  .lh-loc { font-family: Arial, sans-serif; font-size: 12px; color: #667487; margin-top: 2px; }
  .lh-rule { border: 0; border-top: 2px solid #16233b; margin: 14px 0 26px; }
  .parties { display: flex; gap: 40px; margin: 24px 0; font-family: Arial, sans-serif; font-size: 13px; }
  .parties h2 { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #8a94a3; margin-bottom: 5px; }
  .parties div { line-height: 1.6; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 10px; }
  table.items th { font-family: Arial, sans-serif; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #8a94a3; text-align: left; border-bottom: 1px solid #dce2ea; padding: 6px 8px 6px 0; }
  table.items td { padding: 9px 8px 9px 0; border-bottom: 1px solid #eef1f5; font-size: 14px; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-top: 14px; margin-left: auto; width: 260px; font-size: 14px; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .grand { border-top: 2px solid #16233b; margin-top: 6px; padding-top: 8px; font-size: 19px; }
  .pay { margin-top: 30px; border: 1px solid #dce2ea; border-left: 4px solid #c24b2e; padding: 14px 18px; font-size: 14px; }
  .pay h2 { font-family: Arial, sans-serif; font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #8a94a3; margin-bottom: 6px; }
  .pay pre { font-family: Georgia, serif; white-space: pre-wrap; font-size: 14px; }
  .notes { margin-top: 20px; font-size: 14px; color: #3a4658; }
  .foot { margin-top: 34px; border-top: 1px solid #dce2ea; padding-top: 14px; font-family: Arial, sans-serif; font-size: 12px; color: #667487; }
  @media print { .toolbar { display: none; } body { padding: 24px 8px; } }
</style>
</head>
<body>
<div class="toolbar"><span>Save as PDF: hit the button, choose "Save as PDF" as the printer.</span><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="page">
  <div class="letterhead">
    ${logoBlock(fromName)}
    <div>
      <div class="lh-name">${esc(fromName)}</div>
      <div class="lh-loc">${esc(fromLoc)}</div>
    </div>
  </div>
  <hr class="lh-rule">
  <header>
    <div>
      <h1>Invoice</h1>
      ${paid ? '<div class="paidstamp">PAID</div>' : ""}
    </div>
    <div class="meta">
      <div><strong>${esc(invoice.number)}</strong></div>
      <div>Issued ${esc(invoice.issue_date || "")}</div>
      ${invoice.due_date ? `<div>Due ${esc(invoice.due_date)}</div>` : ""}
      ${paid && invoice.paid_date ? `<div>Paid ${esc(invoice.paid_date)}</div>` : ""}
    </div>
  </header>

  <div class="parties">
    <div style="flex:1">
      <h2>From</h2>
      <div>
        ${esc(from.name || BRAND.name)}<br>
        ${esc(from.location || BRAND.location)}
        ${from.email ? `<br>${esc(from.email)}` : ""}
      </div>
    </div>
    <div style="flex:1">
      <h2>Billed to</h2>
      <div>
        ${esc(client.business_name)}
        ${client.owner_name ? `<br>${esc(client.owner_name)}` : ""}
        ${client.email ? `<br>${esc(client.email)}` : ""}
        ${client.phone ? `<br>${esc(client.phone)}` : ""}
      </div>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr><th style="width:60%">Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr>
    </thead>
    <tbody>
      ${items
        .map(
          (i) => `<tr>
            <td>${esc(i.description)}</td>
            <td class="num">${esc(i.qty)}</td>
            <td class="num">${money(i.rate)}</td>
            <td class="num">${money((Number(i.qty) || 0) * (Number(i.rate) || 0))}</td>
          </tr>`
        )
        .join("")}
    </tbody>
  </table>

  <div class="totals">
    <div><span>Subtotal</span><span>${money(sub)}</span></div>
    ${taxRate ? `<div><span>Tax (${taxRate}%)</span><span>${money(tax)}</span></div>` : ""}
    <div class="grand"><span>${paid ? "Paid" : "Amount due"}</span><span>${money(total)}</span></div>
  </div>

  ${invoice.payment_instructions ? `<div class="pay"><h2>How to pay</h2><pre>${esc(invoice.payment_instructions)}</pre></div>` : ""}
  ${invoice.notes ? `<div class="notes">${esc(invoice.notes)}</div>` : ""}

  <div class="foot">Thank you for your business. Questions about this invoice? Just reply to my email.</div>
</div>
</body>
</html>`;

  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  window.open(url, "_blank");
}
