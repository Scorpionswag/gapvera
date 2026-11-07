// Browser dogfood stub for the Google Places lookup page.
//
// Extends provisioned-stub.mjs with the two Pages Function routes, so the real
// built bundle can be driven through a real browser against the real handler
// code — the only way to confirm the UI's cost messaging, attribution, caps
// and refusal states actually render, rather than only being present in source.
//
// Supabase is stubbed (owner signed in). Google is stubbed by default and
// optionally real with --live. The MODE env var selects which refusal state to
// exercise.
//
// Usage:
//   node migration/test-harness/places-stub.mjs [port] [distDir]
//   MODE=cap   node migration/test-harness/places-stub.mjs
//   MODE=nokey node migration/test-harness/places-stub.mjs
//   MODE=live  node migration/test-harness/places-stub.mjs

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";

const port = Number(process.argv[2] || 8799);
const dist = process.argv[3] || "client/dist";
const MODE = process.env.MODE || "ok";
const UID = "00000000-0000-0000-0000-000000000001";

const { onRequest: searchFn } = await import("../../functions/api/places/search.js");
const { onRequest: usageFn } = await import("../../functions/api/places/usage.js");

// The real key, only when explicitly asked for. Never logged.
let realKey = "";
const envPath = `${process.env.HOME}/gapvera/server/.env`;
if (MODE === "live" && existsSync(envPath)) {
  const m = readFileSync(envPath, "utf8").match(/^GOOGLE_MAPS_API_KEY=(.*)$/m);
  realKey = (m?.[1] || "").trim().replace(/^["']|["']$/g, "");
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
};

const SUPA = `http://localhost:${port}`;

// Ledger state the stubbed Supabase answers from. MODE=cap starts it exhausted.
const { LIMITS } = await import("../../functions/_lib/places.js");
let ledger = MODE === "cap" ? { today: LIMITS.perDay, month: LIMITS.perDay } : { today: 2, month: 7 };

const STUB_PLACES = {
  places: [
    {
      id: "ChIJ_dogfood_nosite",
      displayName: { text: "Hialeah Drain & Sewer" },
      formattedAddress: "480 W 29th St, Hialeah, FL 33012",
      nationalPhoneNumber: "(305) 555-0144",
      rating: 4.8,
      userRatingCount: 61,
      googleMapsUri: "https://maps.google.com/?cid=111",
      primaryTypeDisplayName: { text: "Plumber" },
      attributions: [{ provider: "Example Listings Co", providerUri: "https://example.test" }],
    },
    {
      id: "ChIJ_dogfood_site",
      displayName: { text: "Gulfstream Plumbing LLC" },
      formattedAddress: "1201 E 4th Ave, Hialeah, FL 33010",
      nationalPhoneNumber: "(305) 555-0188",
      websiteUri: "https://gulfstream.example",
      rating: 4.1,
      userRatingCount: 204,
      googleMapsUri: "https://maps.google.com/?cid=222",
      primaryTypeDisplayName: { text: "Plumber" },
    },
  ],
};

const realFetch = globalThis.fetch;

// The Function modules call global fetch for Supabase and Google. Route
// Supabase back into this server and Google to the stub (or the real API).
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("places.googleapis.com")) {
    if (MODE === "live") return realFetch(url, options);
    return new Response(JSON.stringify(STUB_PLACES), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(url, options);
};

const FN_ENV = {
  GOOGLE_MAPS_API_KEY: MODE === "nokey" ? "" : realKey || "stub-key",
  SUPABASE_URL: SUPA,
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_stub",
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const LEADS = [
  {
    id: 1,
    business_name: "Riverside Plumbing Co",
    owner_name: "Dana Reyes",
    location: "Miami, FL, USA",
    industry: "Plumbing",
    phone: "305-555-0101",
    email: "dana@riversideplumbing.example",
    website_status: "Outdated",
    outreach_status: "Not Contacted",
    lead_score: 99,
    star_rating: 4.6,
    review_count: 128,
    audit_report: null,
    next_followup_date: "",
    last_contact_date: "",
  },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;

  // ---- GapVera's own Functions: delegate to the REAL handler code ----
  if (path === "/api/places/search" || path === "/api/places/usage") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`https://dogfood.local${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
    });
    const handler = path.endsWith("/usage") ? usageFn : searchFn;
    const out = await handler({ request, env: FN_ENV });
    const text = await out.text();
    const headers = {};
    out.headers.forEach((v, k) => {
      headers[k] = v;
    });
    res.writeHead(out.status, headers);
    return res.end(text);
  }

  // ---- Stubbed Supabase ----
  if (req.method === "OPTIONS") return json(res, 204, {});

  if (path === "/auth/v1/token") {
    return json(res, 200, {
      access_token: "stub-access-token",
      refresh_token: "stub-refresh-token",
      expires_in: 3600,
      token_type: "bearer",
      user: { id: UID, email: "owner@example.com" },
    });
  }
  if (path === "/auth/v1/user") return json(res, 200, { id: UID, email: "owner@example.com" });
  if (path === "/auth/v1/logout") return json(res, 204, {});

  if (path.startsWith("/rest/v1/")) {
    const table = path.slice("/rest/v1/".length).split("?")[0];
    if (table === "app_owner") return json(res, 200, [{ user_id: UID }]);
    if (table === "leads") return json(res, 200, LEADS);

    if (table === "job_runs") {
      if (req.method === "HEAD") {
        const q = decodeURIComponent(url.search);
        const isDay = /\d{4}-\d{2}-\d{2}/.test(q);
        const total = isDay ? ledger.today : ledger.month;
        res.writeHead(200, { "Content-Range": `0-0/${total}`, "Content-Type": "application/json" });
        return res.end();
      }
      if (req.method === "POST") {
        ledger.today += 1;
        ledger.month += 1;
        return json(res, 201, [{ id: ledger.month }]);
      }
      if (req.method === "PATCH") return json(res, 204, {});
    }
    return json(res, 200, []);
  }

  // ---- Static bundle with SPA fallback ----
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  try {
    const file = await readFile(join(dist, rel));
    res.writeHead(200, { "Content-Type": TYPES[extname(rel)] || "application/octet-stream" });
    return res.end(file);
  } catch {
    const shell = await readFile(join(dist, "index.html"));
    res.writeHead(200, { "Content-Type": TYPES[".html"] });
    return res.end(shell);
  }
});

server.listen(port, () => {
  console.log(`places-stub listening on http://localhost:${port} (dist: ${dist}, MODE=${MODE})`);
  if (MODE === "live") console.log(`  LIVE: a real billable Google request per lookup${realKey ? "" : " — NO KEY FOUND"}`);
  if (MODE === "cap") console.log(`  ledger pre-loaded at the daily cap (${LIMITS.perDay})`);
});
