// Route inventory guard (acceptance criterion 15).
//
// index.js cannot be imported in this environment — it loads db.js, which loads
// better-sqlite3, whose vendored binary does not run on this host (see AUTH.md
// "Known environment issue"). So this verifies the property that actually
// matters by reading index.js as source: the gate is installed once, and every
// business route is registered AFTER it.
//
// That makes the guarantee structural. A future endpoint added above the gate
// line fails this test, which is the failure mode a per-route annotation scheme
// cannot catch.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

// Endpoints that are legitimately public: the minimum needed to bootstrap the
// auth UI. Anything else appearing outside the gate is a hole.
const PUBLIC_ROUTES = new Set(["/api/auth/status", "/api/auth/setup", "/api/auth/login", "/api/auth/logout"]);

const GATE = 'app.use("/api", requireAdmin)';

function routeInventory() {
  const re = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  const routes = [];
  let m;
  while ((m = re.exec(source))) {
    routes.push({ method: m[1].toUpperCase(), route: m[2], index: m.index });
  }
  return routes;
}

test("the gate is installed exactly once, on the whole /api surface", () => {
  const occurrences = source.split(GATE).length - 1;
  assert.equal(occurrences, 1, `expected one '${GATE}', found ${occurrences}`);
});

test("every business route is registered after the gate", () => {
  const gateIndex = source.indexOf(GATE);
  assert.ok(gateIndex > 0, "gate not found in index.js");

  const routes = routeInventory();
  // Sanity: the inventory actually found the app's surface, so an empty regex
  // match can never make this test vacuously pass.
  assert.ok(routes.length >= 30, `expected the full route inventory, found ${routes.length}`);

  const unprotected = routes.filter((r) => r.index < gateIndex && !PUBLIC_ROUTES.has(r.route));
  assert.deepEqual(
    unprotected.map((r) => `${r.method} ${r.route}`),
    [],
    "these routes are registered before the auth gate and are therefore public"
  );
});

test("the public surface is exactly the auth bootstrap endpoints", () => {
  const gateIndex = source.indexOf(GATE);
  const publicRoutes = routeInventory()
    .filter((r) => r.index < gateIndex)
    .map((r) => r.route);
  for (const route of publicRoutes) {
    assert.ok(PUBLIC_ROUTES.has(route), `unexpected public route: ${route}`);
  }
});

test("the full business inventory is behind the gate, including every mutation and download", () => {
  const gateIndex = source.indexOf(GATE);
  const protectedRoutes = routeInventory().filter((r) => r.index > gateIndex);
  const names = protectedRoutes.map((r) => `${r.method} ${r.route}`);

  // Spot-check each class of operation the handoff enumerates: record
  // reads/writes, config, exports/downloads, scraping and outreach triggers.
  const expected = [
    "GET /api/config",
    "GET /api/leads",
    "POST /api/leads",
    "PUT /api/leads/:id",
    "DELETE /api/leads/:id",
    "POST /api/leads/bulk",
    "POST /api/leads/:id/run-audit",
    "POST /api/leads/:id/find-email",
    "POST /api/leads/:id/call",
    "DELETE /api/calls/:id",
    "POST /api/leads/:id/convert",
    "GET /api/clients",
    "PUT /api/clients/:id",
    "DELETE /api/clients/:id",
    "POST /api/clients/:id/documents",
    "GET /api/clients/:id/documents",
    "GET /api/documents/:id", // the download path
    "DELETE /api/documents/:id",
    "GET /api/recent-documents",
    "GET /api/invoices",
    "POST /api/clients/:id/invoices",
    "PUT /api/invoices/:id",
    "DELETE /api/invoices/:id",
    "GET /api/templates",
    "POST /api/send-email", // outreach trigger
    "GET /api/email-logs",
    "POST /api/scrape", // scraping trigger
    "POST /api/run-followups", // automation trigger
  ];
  for (const route of expected) {
    assert.ok(names.includes(route), `${route} is not behind the gate`);
  }
});

test("the API binds to loopback only", () => {
  assert.match(source, /app\.listen\(PORT,\s*"127\.0\.0\.1"/);
});

test("sessions are invalidated on startup", () => {
  assert.match(source, /auth\.destroyAllSessions\(\)/);
});

test("the server refuses to start when the auth store is unavailable", () => {
  // createAuth must be wrapped in a try/catch that exits rather than
  // continuing to serve business routes unprotected.
  assert.match(source, /createAuth\(db\)/);
  assert.match(source, /process\.exit\(1\)/);
});

test("the scheduled follow-up job is unchanged by auth and runs outside the request path", () => {
  // Criterion 22: auth must not enable or disable autonomous sends. The cron
  // schedule and both opt-in guards must still be exactly as they were.
  assert.match(source, /cron\.schedule\("0 \* \* \* \*", \(\) => runScheduledFollowups\(\)\)/);
  assert.match(source, /if \(!smtpConfigured && !force\)/);
  assert.match(source, /if \(!AUTO_FOLLOWUPS && !force\)/);
  // The cron callback takes no request, so no session is involved in it.
  assert.equal(source.includes("cron.schedule") && source.includes("requireAdmin, runScheduledFollowups"), false);
});
