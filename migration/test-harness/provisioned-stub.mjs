// Companion to unprovisioned-stub.mjs: a project that IS fully migrated.
//
// Guards against overcorrection. The unprovisioned fix must not change the
// healthy path, so this stub returns a real app_owner row and real leads, and
// the browser must reach the workspace exactly as before.
//
// Usage: node migration/test-harness/provisioned-stub.mjs [port] [distDir]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const port = Number(process.argv[2] || 8798);
const dist = process.argv[3] || "client/dist";
const UID = "00000000-0000-0000-0000-000000000001";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
  });
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
    call_count: 0,
    audit_report: null,
    next_followup_date: "",
    last_contact_date: "",
  },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;
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
    // The owner row exists — this is the whole difference from the other stub.
    if (table === "app_owner") return json(res, 200, [{ user_id: UID }]);
    if (table === "leads") return json(res, 200, LEADS);
    return json(res, 200, []);
  }

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
  console.log(`provisioned-stub listening on http://localhost:${port} (dist: ${dist})`);
});
