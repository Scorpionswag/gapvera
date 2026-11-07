// Reproduction harness for the 2026-11-06 production login failure.
//
// Stands in for a Supabase project whose schema migration was never applied:
//   * GoTrue accepts the password and issues a session (as production did)
//   * PostgREST answers every table with 404 PGRST205 (as production did)
//
// Serves the built client alongside it so the whole flow runs in a real
// browser against real HTTP, not a stubbed fetch. Verification only — this
// file is not part of the shipped app.
//
// Usage: node migration/test-harness/unprovisioned-stub.mjs [port] [distDir]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const port = Number(process.argv[2] || 8799);
const dist = process.argv[3] || "client/dist";

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
    // The browser loads the page from this same origin, but the client calls
    // the Supabase base URL, so preflight/CORS must work like the real thing.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
  });
  res.end(JSON.stringify(body));
};

// Exactly what production returned, code included.
const schemaMissing = (table) => ({
  code: "PGRST205",
  details: null,
  hint: null,
  message: `Could not find the table 'public.${table}' in the schema cache`,
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") return json(res, 204, {});

  // --- GoTrue: the password is correct and a session is issued -------------
  if (path === "/auth/v1/token") {
    return json(res, 200, {
      access_token: "stub-access-token",
      refresh_token: "stub-refresh-token",
      expires_in: 3600,
      token_type: "bearer",
      user: { id: "00000000-0000-0000-0000-000000000001", email: "owner@example.com" },
    });
  }
  if (path === "/auth/v1/user") {
    return json(res, 200, {
      id: "00000000-0000-0000-0000-000000000001",
      email: "owner@example.com",
    });
  }
  if (path === "/auth/v1/logout") return json(res, 204, {});

  // --- PostgREST: the database has no schema ------------------------------
  if (path.startsWith("/rest/v1/")) {
    const table = path.slice("/rest/v1/".length).split("?")[0] || "unknown";
    return json(res, 404, schemaMissing(table));
  }

  // --- static client + SPA fallback ---------------------------------------
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
  console.log(`unprovisioned-stub listening on http://localhost:${port} (dist: ${dist})`);
});
