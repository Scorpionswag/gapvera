// One-click technical website audit: fetches the lead's site and grades the
// basics a web-design pitch leans on. Deterministic checks only — the deep
// marketing brief stays a human/AI job.

// Page text arrives HTML-encoded; decode it or "Lawn Care &amp; Nearby" ends up
// in the report a client reads.
function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#0?39|#x27);/gi, (m, e) =>
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#039": "'", "#x27": "'" }[e.toLowerCase()] ?? m))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export async function runAudit(rawUrl) {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  // 'sv' locale renders YYYY-MM-DD in local time — UTC would date evening
  // scans tomorrow.
  const scanned = new Date().toLocaleDateString("sv");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let res, html = "", ms = 0;
  try {
    const started = Date.now();
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; GapVera-audit/0.1)" },
    });
    html = await res.text();
    ms = Date.now() - started;
  } catch (err) {
    clearTimeout(timer);
    return {
      fetched_at: new Date().toISOString(),
      scanned,
      url,
      grade: "F",
      score: 0,
      checks: [{ name: "Site reachable", status: "fail", detail: err.name === "AbortError" ? "timed out after 12s" : err.message }],
    };
  }
  clearTimeout(timer);

  const finalUrl = res.url || url;
  add("Site reachable", res.ok ? "pass" : "fail", `HTTP ${res.status}`);
  add("HTTPS", finalUrl.startsWith("https://") ? "pass" : "fail", finalUrl.startsWith("https://") ? "secure" : "served over plain HTTP");
  add("Load time", ms < 1500 ? "pass" : ms < 4000 ? "warn" : "fail", `${ms} ms to fetch homepage HTML`);
  add("Page weight", html.length < 1_000_000 ? "pass" : "warn", `${Math.round(html.length / 1024)} KB of HTML`);

  const title = decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "");
  add("Title tag", title ? (title.length <= 70 ? "pass" : "warn") : "fail", title ? `"${title.slice(0, 80)}" (${title.length} chars)` : "missing");

  const desc = decodeEntities(html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || "");
  add("Meta description", desc ? "pass" : "fail", desc ? `${desc.length} chars` : "missing, so Google writes their snippet for them");

  add("Mobile viewport", /<meta[^>]+name=["']viewport["']/i.test(html) ? "pass" : "fail",
    /<meta[^>]+name=["']viewport["']/i.test(html) ? "declared" : "missing, so the site is not mobile-optimized");

  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  add("H1 heading", h1s === 1 ? "pass" : h1s === 0 ? "fail" : "warn", h1s === 0 ? "no H1 on homepage" : `${h1s} H1 tag(s)`);

  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const withAlt = imgs.filter((t) => /alt=["'][^"']+["']/i.test(t)).length;
  add("Image alt text", imgs.length === 0 || withAlt / imgs.length >= 0.8 ? "pass" : withAlt / imgs.length >= 0.4 ? "warn" : "fail",
    imgs.length ? `${withAlt}/${imgs.length} images have alt text` : "no images in HTML");

  add("Social preview (OpenGraph)", /<meta[^>]+property=["']og:/i.test(html) ? "pass" : "warn",
    /<meta[^>]+property=["']og:/i.test(html) ? "og tags present" : "links shared to Facebook/iMessage get no preview card");

  add("Tap-to-call link", /href=["']tel:/i.test(html) ? "pass" : "warn",
    /href=["']tel:/i.test(html) ? "tel: link present" : "phone customers must copy the number by hand");

  add("Contact form", /<form[\s>]/i.test(html) ? "pass" : "warn",
    /<form[\s>]/i.test(html) ? "form present" : "no form on homepage");

  const yearMatch = html.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/i);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    const now = new Date().getFullYear();
    add("Copyright year", year >= now - 1 ? "pass" : "warn", year >= now - 1 ? `${year}` : `footer says ${year}, which reads abandoned`);
  }

  try {
    const origin = new URL(finalUrl).origin;
    const robots = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(6000) });
    add("robots.txt", robots.ok ? "pass" : "warn", robots.ok ? "present" : "missing");
    const sitemap = await fetch(`${origin}/sitemap.xml`, { signal: AbortSignal.timeout(6000) });
    add("Sitemap", sitemap.ok ? "pass" : "warn", sitemap.ok ? "present" : "missing");
  } catch {
    add("robots.txt / sitemap", "warn", "could not check");
  }

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const score = Math.max(0, 100 - fails * 12 - warns * 5);
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 45 ? "D" : "F";

  return { fetched_at: new Date().toISOString(), scanned, url: finalUrl, grade, score, checks };
}

// Harvest candidate email addresses from a lead's site: homepage plus the
// first same-origin "contact" page it links to. Returns up to 5 candidates —
// the user picks; nothing is saved automatically.
export async function findEmails(rawUrl) {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const found = new Set();
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; GapVera-audit/0.1)" };
  const grab = (html) => {
    for (const m of html.matchAll(/mailto:([^"'?\s<>]+)/gi)) found.add(decodeURIComponent(m[1]).toLowerCase());
    for (const m of html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi)) found.add(m[0].toLowerCase());
  };
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10000), headers });
    const html = await res.text();
    grab(html);
    const base = new URL(res.url || url);
    const link = html.match(/<a[^>]+href=["']([^"']*contact[^"']*)["']/i)?.[1];
    if (link && !/^(mailto:|tel:|javascript:|#)/i.test(link)) {
      const contactUrl = new URL(link, base);
      if (contactUrl.origin === base.origin) {
        const res2 = await fetch(contactUrl.href, { signal: AbortSignal.timeout(8000), headers });
        grab(await res2.text());
      }
    }
  } catch {
    // unreachable site → just return whatever was found (usually nothing)
  }
  const junk = /\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$|@(example|sentry|wixpress|godaddy|placeholder|domain|email|yourdomain)\.|^[0-9.]+@/i;
  return [...found].filter((e) => !junk.test(e) && e.includes(".") && e.length < 60).slice(0, 5);
}
