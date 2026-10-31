import nodemailer from "nodemailer";
import db from "./db.js";

const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER);

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

// Scraped locations are full street addresses ("17148 Carleen Ave, Port
// Charlotte, FL 33948, USA") — the city is third from the end, never first.
export function cityFrom(location) {
  const parts = (location || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 3];
  return parts[0] || "";
}

// The most customer-felt finding from the lead's audit, phrased for an owner,
// not a developer. Priority: what loses them business fastest.
export function siteIssue(lead) {
  const fallback = "a few things on your site are quietly working against you on Google";
  try {
    const rep = JSON.parse(lead.audit_report || "null");
    if (!rep?.checks) return fallback;
    const find = (name) => rep.checks.find((c) => c.name === name);
    const bad = (name) => { const c = find(name); return c && c.status !== "pass"; };
    if (bad("Site reachable")) return "your website wasn't loading at all when I checked";
    if (bad("Mobile viewport")) return "your site doesn't adjust for phones, and that's where most local customers are searching from";
    const lt = find("Load time");
    if (lt && lt.status !== "pass") {
      const ms = Number(lt.detail.match(/\d+/)?.[0] || 0);
      return `your site took about ${(ms / 1000).toFixed(1)} seconds to come up when I checked, and people give up fast`;
    }
    if (bad("HTTPS")) return 'your site loads without the padlock, so browsers warn visitors it is "not secure"';
    if (bad("Contact form")) return "there's no way for a visitor to send you a message from your homepage, so after-hours customers have nowhere to go";
    if (bad("Meta description")) return "Google is writing its own description of your business under your search result instead of the one you'd choose";
    if (bad("Tap-to-call link")) return "your phone number isn't tappable on a phone, so calling you takes copy-and-paste";
    if (bad("Title tag")) return "your homepage isn't telling Google clearly what you do";
    return fallback;
  } catch {
    return fallback;
  }
}

export function fillPlaceholders(text, lead) {
  const first = (lead.owner_name || "").trim().split(/\s+/)[0];
  const greeting = first ? `Hi ${first},` : `Hi ${lead.business_name} team,`;
  return (text || "")
    .replaceAll("{greeting}", greeting)
    .replaceAll("{business_name}", lead.business_name || "")
    .replaceAll("{owner_name}", lead.owner_name || "there")
    .replaceAll("{city}", cityFrom(lead.location))
    .replaceAll("{industry}", lead.industry || "")
    .replaceAll("{rating}", String(lead.star_rating || ""))
    .replaceAll("{reviews}", String(lead.review_count || ""))
    .replaceAll("{site_issue}", siteIssue(lead));
}

// Sends for real when SMTP is configured, otherwise logs as "mock" so the
// full outreach flow is testable without credentials.
export async function sendEmail({ lead, subject, body, templateId = null, scheduledFor = "" }) {
  const filledSubject = fillPlaceholders(subject, lead);
  const filledBody = fillPlaceholders(body, lead);
  let status = "mock";

  if (smtpConfigured && lead.email) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: lead.email,
        subject: filledSubject,
        text: filledBody,
      });
      status = "sent";
    } catch (err) {
      status = "failed: " + err.message;
    }
  }

  db.prepare(
    `INSERT INTO email_logs (lead_id, template_id, to_email, subject, body, status, scheduled_for)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(lead.id, templateId, lead.email, filledSubject, filledBody, status, scheduledFor);

  return { status, subject: filledSubject };
}

export { smtpConfigured };
