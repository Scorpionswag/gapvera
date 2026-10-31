import { BRAND } from "./brand.js";
// Turns a lead's stored diagnostics into a clean, light, print-ready report
// page the user can save as PDF and attach to a reply. Deliverable rules: no
// links, no GapVera branding, signed with the name in brand.js.

const GRADE_NOTES = {
  A: "Excellent shape. Only small polish left.",
  B: "Solid. A few easy wins left on the table.",
  C: "The site works, but it leaves easy wins on the table.",
  D: "Visitors are running into real problems.",
  F: "The site is actively costing you customers.",
};

const GRADE_COLORS = { A: "#16a34a", B: "#16a34a", C: "#c2540f", D: "#e5484d", F: "#e5484d" };

// Also converts em/en dashes to commas: client-facing copy carries none, and
// older stored reports may still contain them.
const esc = (s) =>
  String(s ?? "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Letterhead identity: your logo image if BRAND.logo is set, otherwise a
// monogram of your initials in a brand-rust badge.
const initials = (name) => {
  const words = (name || "").split(/\s+/).filter(Boolean);
  // A one-word CamelCase brand ("GapVera") should read "GV", not "G". Requires a
  // lowercase tail so acronyms ("ACME", "3M") stay single-letter as before.
  const camel = (words[0] || "").match(/[A-Z][a-z]+/g);
  const parts = words.length > 1 ? words : camel && camel.length > 1 ? camel : words;
  return parts.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "•";
};

const logoBlock = (px = 46) =>
  BRAND.logo
    ? `<img class="lh-img" src="${esc(BRAND.logo)}" alt="${esc(BRAND.name)}" style="height:${px}px">`
    : `<div class="monogram" style="width:${px}px;height:${px}px">${esc(initials(BRAND.name))}</div>`;

export function openAuditReport(lead, reportOverride = null) {
  let report = reportOverride;
  if (!report) {
    try { report = JSON.parse(lead.audit_report || "null"); } catch { report = null; }
  }
  if (!report?.checks) return;

  const fails = report.checks.filter((c) => c.status === "fail");
  const warns = report.checks.filter((c) => c.status === "warn");
  const passes = report.checks.filter((c) => c.status === "pass");
  const color = GRADE_COLORS[report.grade] || "#c2540f";

  const section = (title, items, mark, markColor) =>
    items.length
      ? `<h2>${title}</h2><table>${items
          .map((c) => `<tr><td class="mark" style="color:${markColor}">${mark}</td><td class="check">${esc(c.name)}</td><td class="detail">${esc(c.detail)}</td></tr>`)
          .join("")}</table>`
      : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Website Checkup - ${esc(lead.business_name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #16233b; background: #fff; max-width: 720px; margin: 0 auto; padding: 48px 32px; line-height: 1.5; }
  .toolbar { position: fixed; top: 0; left: 0; right: 0; background: #16233b; color: #fff; padding: 10px 16px; font-family: Arial, sans-serif; font-size: 13px; display: flex; justify-content: space-between; align-items: center; }
  .toolbar button { background: #fff; color: #16233b; border: 0; padding: 6px 14px; font-weight: bold; cursor: pointer; border-radius: 4px; }
  .page { margin-top: 40px; }
  .letterhead { display: flex; align-items: center; gap: 14px; }
  .monogram { background: #c24b2e; color: #fff; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-family: Arial, sans-serif; font-weight: bold; font-size: 17px; letter-spacing: 0.03em; }
  .lh-img { width: auto; display: block; }
  .lh-name { font-size: 20px; color: #16233b; line-height: 1.1; }
  .lh-loc { font-family: Arial, sans-serif; font-size: 12px; color: #667487; margin-top: 2px; }
  .lh-rule { border: 0; border-top: 2px solid #16233b; margin: 14px 0 26px; }
  .kicker { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #c24b2e; }
  h1 { font-size: 30px; font-weight: normal; margin: 6px 0 2px; }
  .site { font-family: Arial, sans-serif; font-size: 13px; color: #667487; }
  .gradebox { display: flex; align-items: center; gap: 18px; border: 1px solid #dce2ea; border-left: 4px solid ${color}; padding: 16px 20px; margin: 24px 0; }
  .grade { font-size: 52px; color: ${color}; line-height: 1; }
  .gradenote { font-family: Arial, sans-serif; font-size: 14px; }
  .gradenote .sub { color: #667487; font-size: 12px; margin-top: 4px; }
  h2 { font-family: Arial, sans-serif; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: #8a94a3; margin: 26px 0 8px; border-bottom: 1px solid #dce2ea; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 8px 6px 0; vertical-align: top; font-size: 14px; }
  td.mark { width: 22px; font-family: Arial, sans-serif; font-weight: bold; }
  td.check { width: 190px; font-weight: bold; font-family: Arial, sans-serif; font-size: 13px; }
  td.detail { color: #3a4658; }
  .foot { margin-top: 36px; border-top: 1px solid #dce2ea; padding-top: 16px; font-size: 14px; }
  .foot .sig { margin-top: 14px; font-family: Arial, sans-serif; font-size: 13px; color: #3a4658; }
  .fine { font-family: Arial, sans-serif; font-size: 11px; color: #8a94a3; margin-top: 18px; }
  @media print { .toolbar { display: none; } body { padding: 24px 8px; } }
</style>
</head>
<body>
<div class="toolbar"><span>Save this as a PDF: hit the button, choose "Save as PDF" as the printer.</span><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="page">
  <div class="letterhead">
    ${logoBlock()}
    <div>
      <div class="lh-name">${esc(BRAND.name)}</div>
      <div class="lh-loc">${esc(BRAND.location)}</div>
    </div>
  </div>
  <hr class="lh-rule">
  <div class="kicker">Website Checkup &middot; ${esc(report.scanned || (report.fetched_at || "").slice(0, 10))}</div>
  <h1>${esc(lead.business_name)}</h1>
  <div class="site">${esc(report.url || lead.website_url)}</div>

  <div class="gradebox">
    <div class="grade">${esc(report.grade)}</div>
    <div class="gradenote">
      <div>${GRADE_NOTES[report.grade] || ""}</div>
      <div class="sub">${report.score}/100 &middot; ${fails.length} problem${fails.length === 1 ? "" : "s"}, ${warns.length} worth fixing, ${passes.length} already working</div>
    </div>
  </div>

  ${section("Costing you customers", fails, "✗", "#e5484d")}
  ${section("Worth fixing", warns, "!", "#c2540f")}
  ${section("Already working well", passes, "✓", "#16a34a")}

  <div class="foot">
    Every item above is fixable, and most of them are quick. If you'd like, I can walk you through this over a ten minute call and tell you honestly which ones matter for your business and which ones don't.
    <div class="sig">${esc(BRAND.name)} &middot; ${esc(BRAND.location)}<br>Just reply to my email and we'll set it up.</div>
    <div class="fine">This is an automated technical checkup of the site's homepage, run ${esc(report.scanned || "")}. It covers speed, mobile readiness, search visibility and contact paths. A full review goes deeper.</div>
  </div>
</div>
</body>
</html>`;

  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  window.open(url, "_blank");
}
