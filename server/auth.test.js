// Auth and permissions tests. Run: npm test -w server
//
// These use node:sqlite rather than better-sqlite3 as the database handle.
// auth.js takes its handle as an argument and deliberately sticks to the
// prepare()/exec() subset both drivers share, so the policy under test is the
// same code the server runs. (On this host the vendored better-sqlite3
// prebuild is a Node 22 binary and cannot load under Node 26 at all — see
// AUTH.md "Known environment issue".)

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import express from "express";
import { createAuth, POLICY, SESSION_COOKIE, AuthStoreUnavailable } from "./auth.js";
import { installAuth, parseCookies, originAllowed, isLoopbackHost, isLoopbackAddress } from "./authRoutes.js";

const GOOD_PASSWORD = "correct horse battery staple"; // 28 chars, spaces: in policy

// A clock the tests drive by hand, so session expiry is asserted exactly rather
// than waited out.
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function freshAuth(clock = fakeClock()) {
  const db = new DatabaseSync(":memory:");
  return { db, auth: createAuth(db, { now: clock.now }), clock };
}

// ---------------------------------------------------------------- password policy

test("password policy accepts the approved range and rejects outside it", () => {
  const { auth } = freshAuth();
  assert.equal(auth.checkPassword("x".repeat(POLICY.passwordMin)).ok, true);
  assert.equal(auth.checkPassword("x".repeat(POLICY.passwordMax)).ok, true);
  assert.equal(auth.checkPassword("x".repeat(POLICY.passwordMin - 1)).ok, false);
  assert.equal(auth.checkPassword("x".repeat(POLICY.passwordMax + 1)).ok, false);
  assert.equal(POLICY.passwordMin, 15);
  assert.equal(POLICY.passwordMax, 128);
});

test("spaces are legal and are not trimmed from the secret", () => {
  const { auth } = freshAuth();
  const withSpaces = "  a pass phrase with spaces  ";
  assert.equal(auth.checkPassword(withSpaces).ok, true);
  assert.equal(auth.createAdmin(withSpaces, withSpaces).ok, true);
  // The trimmed variant is a different password and must not authenticate.
  assert.equal(auth.login({ username: "admin", password: withSpaces.trim() }).ok, false);
  assert.equal(auth.login({ username: "admin", password: withSpaces }).ok, true);
});

test("password length counts code points, not UTF-16 units", () => {
  const { auth } = freshAuth();
  // 8 emoji = 16 UTF-16 units but only 8 characters: must be rejected.
  assert.equal(auth.checkPassword("😀".repeat(8)).ok, false);
  assert.equal(auth.checkPassword("😀".repeat(15)).ok, true);
});

test("non-string passwords are rejected rather than coerced", () => {
  const { auth } = freshAuth();
  for (const bad of [undefined, null, 12345678901234567890, {}, []]) {
    assert.equal(auth.checkPassword(bad).ok, false);
  }
});

// ---------------------------------------------------------------- admin setup

test("first setup creates exactly one admin; every later attempt fails", () => {
  const { auth, db } = freshAuth();
  assert.equal(auth.adminExists(), false);
  assert.equal(auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD).ok, true);
  assert.equal(auth.adminExists(), true);

  const second = auth.createAdmin("a different long passphrase", "a different long passphrase");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "exists");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_admin").get().n, 1);
  // The original password still works — the second attempt replaced nothing.
  assert.equal(auth.login({ username: "admin", password: GOOD_PASSWORD }).ok, true);
});

test("the one-admin limit is a database invariant, not a read-then-write check", () => {
  const { auth, db } = freshAuth();
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  // Simulates the losing side of a concurrent setup race, which bypasses the
  // application's existence check entirely and hits the primary key directly.
  assert.throws(() =>
    db
      .prepare("INSERT INTO auth_admin (id, username, password_hash, created_at) VALUES (1, 'admin', 'x', 0)")
      .run()
  );
  // And a non-1 id is refused by the CHECK constraint, so there is no second row.
  assert.throws(() =>
    db
      .prepare("INSERT INTO auth_admin (id, username, password_hash, created_at) VALUES (2, 'admin2', 'x', 0)")
      .run()
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_admin").get().n, 1);
});

test("mismatched confirmation creates no admin", () => {
  const { auth } = freshAuth();
  const result = auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD + "typo");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "mismatch");
  assert.equal(auth.adminExists(), false);
});

test("an out-of-policy password creates no admin", () => {
  const { auth } = freshAuth();
  assert.equal(auth.createAdmin("short", "short").ok, false);
  assert.equal(auth.adminExists(), false);
});

// ---------------------------------------------------------------- stored secrets

test("stored hash is salted scrypt and reveals nothing of the password", () => {
  const { auth, db } = freshAuth();
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const row = db.prepare("SELECT password_hash FROM auth_admin WHERE id = 1").get();
  assert.match(row.password_hash, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!row.password_hash.includes(GOOD_PASSWORD));
  assert.ok(!row.password_hash.toLowerCase().includes("horse"));
});

test("the same password hashes differently each time (unique salt)", () => {
  const { auth } = freshAuth();
  const a = auth.hashPassword(GOOD_PASSWORD);
  const b = auth.hashPassword(GOOD_PASSWORD);
  assert.notEqual(a, b);
  assert.equal(auth.verifyPassword(GOOD_PASSWORD, a), true);
  assert.equal(auth.verifyPassword(GOOD_PASSWORD, b), true);
  assert.equal(auth.verifyPassword("wrong wrong wrong wrong", a), false);
});

test("session tokens are stored only as hashes, never in replayable form", () => {
  const { auth, db } = freshAuth();
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const { token } = auth.login({ username: "admin", password: GOOD_PASSWORD });
  const rows = db.prepare("SELECT token_hash FROM auth_sessions").all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].token_hash.length, 64); // sha256 hex
});

// ---------------------------------------------------------------- login

test("login succeeds only for the fixed admin identity and correct password", () => {
  const { auth } = freshAuth();
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  assert.equal(auth.login({ username: "admin", password: GOOD_PASSWORD }).ok, true);
  assert.equal(auth.login({ username: "ADMIN", password: GOOD_PASSWORD }).ok, true); // case-insensitive name
  assert.equal(auth.login({ username: "root", password: GOOD_PASSWORD }).ok, false);
  assert.equal(auth.login({ username: "admin", password: "wrong but long enough" }).ok, false);
});

test("login before setup fails with the same generic reason as a bad password", () => {
  const { auth } = freshAuth();
  const noAdmin = auth.login({ username: "admin", password: GOOD_PASSWORD });
  assert.equal(noAdmin.ok, false);
  assert.equal(noAdmin.reason, "invalid");

  const { auth: auth2 } = freshAuth();
  auth2.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const badPass = auth2.login({ username: "admin", password: "definitely not the one" });
  assert.equal(badPass.reason, noAdmin.reason);
});

test("successful login rotates the session identifier and kills the old one", () => {
  const { auth } = freshAuth();
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const first = auth.login({ username: "admin", password: GOOD_PASSWORD }).token;
  const second = auth.login({ username: "admin", password: GOOD_PASSWORD, currentToken: first }).token;
  assert.notEqual(first, second);
  assert.equal(auth.resolveSession(first).valid, false);
  assert.equal(auth.resolveSession(second).valid, true);
});

// ---------------------------------------------------------------- throttling

test("five failures in the window trigger the cooldown, correct password included", () => {
  const clock = fakeClock();
  const { auth } = freshAuth(clock);
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);

  for (let i = 0; i < POLICY.maxFailures; i++) {
    const r = auth.login({ username: "admin", password: "wrong password here" });
    assert.equal(r.ok, false, `attempt ${i + 1} should fail`);
    assert.equal(r.reason, "invalid");
    clock.advance(1000);
  }
  // Locked out now — even the right password is refused.
  const locked = auth.login({ username: "admin", password: GOOD_PASSWORD });
  assert.equal(locked.ok, false);
  assert.equal(locked.reason, "throttled");
  assert.ok(locked.retryAfterMs > 0);

  // Still locked just before the cooldown elapses.
  clock.advance(POLICY.cooldownMs - 2000);
  assert.equal(auth.login({ username: "admin", password: GOOD_PASSWORD }).reason, "throttled");

  // Open again once it passes.
  clock.advance(3000);
  assert.equal(auth.login({ username: "admin", password: GOOD_PASSWORD }).ok, true);
});

test("failures aging out of the window do not accumulate into a lockout", () => {
  const clock = fakeClock();
  const { auth } = freshAuth(clock);
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  for (let i = 0; i < 12; i++) {
    auth.login({ username: "admin", password: "wrong password here" });
    clock.advance(POLICY.failureWindowMs / 2 + 1000); // spaced beyond the window
  }
  assert.equal(auth.throttleState().locked, false);
  assert.equal(auth.login({ username: "admin", password: GOOD_PASSWORD }).ok, true);
});

test("a successful login clears the failure counter", () => {
  const clock = fakeClock();
  const { auth } = freshAuth(clock);
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  for (let i = 0; i < POLICY.maxFailures - 1; i++) auth.login({ username: "admin", password: "wrong password here" });
  assert.equal(auth.login({ username: "admin", password: GOOD_PASSWORD }).ok, true);
  assert.equal(auth.throttleState().failures, 0);
});

// ---------------------------------------------------------------- sessions

test("session slides forward on use and dies at the idle limit", () => {
  const clock = fakeClock();
  const { auth } = freshAuth(clock);
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const { token } = auth.login({ username: "admin", password: GOOD_PASSWORD });

  // Active use keeps it alive well past the idle window.
  for (let i = 0; i < 10; i++) {
    clock.advance(POLICY.idleMs - 60_000);
    assert.equal(auth.resolveSession(token).valid, true);
  }
  clock.advance(POLICY.idleMs + 1000);
  const dead = auth.resolveSession(token);
  assert.equal(dead.valid, false);
  assert.equal(dead.reason, "idle");
});

test("session dies at the absolute limit however active it has been", () => {
  const clock = fakeClock();
  const { auth } = freshAuth(clock);
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const { token } = auth.login({ username: "admin", password: GOOD_PASSWORD });

  // Step by less than the idle window so idle expiry can never be the cause;
  // the only limit left to trip is the 12-hour absolute ceiling.
  const step = POLICY.idleMs / 2;
  let elapsed = 0;
  let reason = null;
  while (elapsed <= POLICY.absoluteMs + step) {
    clock.advance(step);
    elapsed += step;
    const session = auth.resolveSession(token);
    if (!session.valid) {
      reason = session.reason;
      break;
    }
  }
  assert.equal(reason, "absolute");
  // And it died because of age, not inactivity: elapsed passed 12 hours.
  assert.ok(elapsed > POLICY.absoluteMs, `expired after ${elapsed}ms`);
});

test("an expired session is deleted, not merely reported invalid", () => {
  const clock = fakeClock();
  const { auth, db } = freshAuth(clock);
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const { token } = auth.login({ username: "admin", password: GOOD_PASSWORD });
  clock.advance(POLICY.idleMs + 1);
  auth.resolveSession(token);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n, 0);
});

test("logout invalidates the server session; the old token is dead", () => {
  const { auth } = freshAuth();
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const { token } = auth.login({ username: "admin", password: GOOD_PASSWORD });
  assert.equal(auth.destroySession(token), true);
  assert.equal(auth.resolveSession(token).valid, false);
  assert.equal(auth.destroySession(token), false); // already gone
});

test("garbage, empty and forged tokens never resolve", () => {
  const { auth } = freshAuth();
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  auth.login({ username: "admin", password: GOOD_PASSWORD });
  for (const bad of ["", null, undefined, "x", "a".repeat(43), { token: 1 }, 12345]) {
    assert.equal(auth.resolveSession(bad).valid, false);
  }
});

test("restart invalidates every outstanding session", () => {
  const { auth } = freshAuth();
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const a = auth.login({ username: "admin", password: GOOD_PASSWORD }).token;
  const b = auth.issueSession();
  auth.destroyAllSessions(); // what index.js does on boot
  assert.equal(auth.resolveSession(a).valid, false);
  assert.equal(auth.resolveSession(b).valid, false);
});

// ---------------------------------------------------------------- bootstrap status

test("bootstrap status exposes only setup/session state and the password rule", () => {
  const { auth } = freshAuth();
  const before = auth.status(null);
  assert.deepEqual(Object.keys(before).sort(), [
    "authenticated",
    "passwordPolicy",
    "setupRequired",
    "username",
  ]);
  assert.equal(before.setupRequired, true);
  assert.equal(before.authenticated, false);

  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const { token } = auth.login({ username: "admin", password: GOOD_PASSWORD });
  const after = auth.status(token);
  assert.equal(after.setupRequired, false);
  assert.equal(after.authenticated, true);
  assert.equal(after.username, "admin");
  // No hint about why a session is absent, and nothing about configuration.
  assert.equal(JSON.stringify(after).includes("smtp"), false);
});

// ---------------------------------------------------------------- fail closed

test("an unreadable auth store throws instead of looking like a fresh install", () => {
  const db = new DatabaseSync(":memory:");
  const auth = createAuth(db);
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  db.exec("DROP TABLE auth_admin"); // simulate corruption/unavailability
  assert.throws(() => auth.adminExists(), AuthStoreUnavailable);
  assert.throws(() => auth.status(null), AuthStoreUnavailable);
  // Critically: it does NOT return setupRequired:true, which would invite
  // re-bootstrapping a damaged installation.
});

// ---------------------------------------------------------------- helpers

test("cookie parsing handles quirks without throwing", () => {
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("a=1; a=2").a, "1"); // first wins
  assert.deepEqual(parseCookies("weird"), {});
  assert.deepEqual(parseCookies("v=a%20b"), { v: "a b" });
});

test("loopback host and address recognition", () => {
  for (const h of ["localhost", "localhost:5173", "127.0.0.1:3001", "[::1]:3001"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["example.com", "192.168.1.9:3001", "gapvera.io", ""]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("10.0.0.4"), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test("origin check rejects foreign origins and allows same/loopback origins", () => {
  const req = (headers) => ({ headers });
  assert.equal(originAllowed(req({ host: "localhost:3001", origin: "http://localhost:3001" })), true);
  assert.equal(originAllowed(req({ host: "localhost:3001", origin: "http://localhost:5173" })), true);
  assert.equal(originAllowed(req({ host: "localhost:3001", origin: "http://evil.example" })), false);
  assert.equal(originAllowed(req({ host: "localhost:3001", referer: "http://evil.example/x" })), false);
  assert.equal(originAllowed(req({ host: "localhost:3001" })), true); // non-browser caller
  assert.equal(originAllowed(req({ host: "localhost:3001", origin: "garbage" })), false);
});

// ---------------------------------------------------------------- HTTP integration

// Builds an app wired exactly as index.js wires it: public auth endpoints, then
// the single positional gate, then business routes.
function buildApp({ clock = fakeClock(), seedAdmin = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const auth = createAuth(db, { now: clock.now });
  if (seedAdmin) auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);

  const app = express();
  app.use(express.json());
  const { requireAdmin } = installAuth(app, auth);
  app.use("/api", requireAdmin);

  // Stand-ins for the business surface: a read, a write, and a download.
  app.get("/api/leads", (req, res) => res.json([{ id: 1, business_name: "Secret Co", role: req.auth.role }]));
  app.post("/api/leads", (_req, res) => res.json({ created: true }));
  app.get("/api/documents/:id", (_req, res) => res.json({ file: "contract.pdf" }));

  return { app, auth, db, clock };
}

// Each test gets its own server; agent:false keeps connections from leaking
// between them.
async function withServer(ctx, fn) {
  const server = ctx.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, init = {}) =>
    fetch(`${base}${path}`, { redirect: "manual", ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
  try {
    return await fn(call, base);
  } finally {
    server.close();
    await new Promise((r) => server.once("close", r));
  }
}

const cookieFrom = (res) => {
  const raw = res.headers.get("set-cookie") || "";
  const match = raw.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`));
  return match ? match[1] : null;
};

test("HTTP: every business route rejects an unauthenticated request with 401", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const probes = [
      ["/api/leads", { method: "GET" }],
      ["/api/leads", { method: "POST", body: "{}" }],
      ["/api/documents/1", { method: "GET" }],
      ["/api/leads?x=1", { method: "GET" }],
    ];
    for (const [path, init] of probes) {
      const res = await call(path, init);
      assert.equal(res.status, 401, `${init.method} ${path}`);
      const body = await res.text();
      // No business data in a denial.
      assert.equal(body.includes("Secret Co"), false);
      assert.equal(body.includes("contract.pdf"), false);
    }
  });
});

test("HTTP: the full login → use → logout → denied cycle", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);
    assert.ok(cookie);

    const ok = await call("/api/leads", { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json())[0].business_name, "Secret Co");

    const out = await call("/api/auth/logout", { method: "POST", headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);

    // Replaying the old cookie — the "other open tab" / back-button case.
    const replay = await call("/api/leads", { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } });
    assert.equal(replay.status, 401);
    assert.equal((await replay.text()).includes("Secret Co"), false);
  });
});

test("HTTP: session cookie carries HttpOnly, SameSite=Strict, Path=/ and no Domain", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const res = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    const raw = res.headers.get("set-cookie");
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Strict/);
    assert.match(raw, /Path=\//);
    assert.equal(/Domain=/i.test(raw), false);
    // No Secure under explicit HTTP loopback operation (it would never be sent).
    assert.equal(/Secure/.test(raw), false);
  });
});

test("HTTP: Secure is added when configured for HTTPS", async () => {
  const db = new DatabaseSync(":memory:");
  const auth = createAuth(db);
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const app = express();
  app.use(express.json());
  const { requireAdmin } = installAuth(app, auth, { secureCookies: true });
  app.use("/api", requireAdmin);
  await withServer({ app }, async (call) => {
    const res = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    assert.match(res.headers.get("set-cookie"), /Secure/);
  });
});

test("HTTP: login failure is generic and discloses nothing about the account", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const wrongPass = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "wrong password value" }),
    });
    const wrongUser = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "nobody", password: GOOD_PASSWORD }),
    });
    assert.equal(wrongPass.status, 401);
    assert.equal(wrongUser.status, 401);
    assert.deepEqual(await wrongPass.json(), await wrongUser.json());
    assert.equal(wrongPass.headers.get("set-cookie"), null);
  });
});

test("HTTP: throttle returns 429 with Retry-After after five failures", async () => {
  const clock = fakeClock();
  const ctx = buildApp({ seedAdmin: true, clock });
  await withServer(ctx, async (call) => {
    const attempt = (password) =>
      call("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "admin", password }) });
    for (let i = 0; i < POLICY.maxFailures; i++) {
      assert.equal((await attempt("wrong password value")).status, 401);
    }
    const locked = await attempt(GOOD_PASSWORD);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);

    clock.advance(POLICY.cooldownMs + 1000);
    assert.equal((await attempt(GOOD_PASSWORD)).status, 200);
  });
});

test("HTTP: client-supplied role claims cannot grant access", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const forged = [
      { Cookie: `${SESSION_COOKIE}=forged-token-value` },
      { Cookie: "gv_role=admin; authenticated=true" },
      { "X-Role": "admin", "X-Admin": "1", Authorization: "Bearer admin" },
    ];
    for (const headers of forged) {
      assert.equal((await call("/api/leads", { headers })).status, 401);
    }
    // A role field in the body is ignored too.
    const body = await call("/api/leads", { method: "POST", body: JSON.stringify({ role: "admin", authenticated: true }) });
    assert.equal(body.status, 401);
  });
});

test("HTTP: role on the request comes from the trusted session record", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    const res = await call("/api/leads", {
      headers: { Cookie: `${SESSION_COOKIE}=${cookieFrom(login)}`, "X-Role": "superuser" },
    });
    assert.equal((await res.json())[0].role, "admin");
  });
});

test("HTTP: cross-origin mutations are rejected; same-origin ones proceed", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call, base) => {
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    const cookie = `${SESSION_COOKIE}=${cookieFrom(login)}`;

    const evil = await call("/api/leads", {
      method: "POST",
      body: "{}",
      headers: { Cookie: cookie, Origin: "http://evil.example" },
    });
    assert.equal(evil.status, 403);

    const same = await call("/api/leads", {
      method: "POST",
      body: "{}",
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(same.status, 200);

    // Setup and login are protected too, not just business mutations.
    for (const path of ["/api/auth/setup", "/api/auth/login", "/api/auth/logout"]) {
      const res = await call(path, { method: "POST", body: "{}", headers: { Origin: "http://evil.example" } });
      assert.equal(res.status, 403, path);
    }
  });
});

test("HTTP: a non-loopback Host header is refused", async () => {
  const ctx = buildApp({ seedAdmin: true });
  const server = ctx.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  try {
    // fetch() forbids overriding Host, so this goes out over a raw socket —
    // which is also closer to how a reverse proxy or attacker would present a
    // spoofed Host.
    const raw = await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write("GET /api/auth/status HTTP/1.1\r\nHost: gapvera.example.com\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(raw.split("\r\n")[0], /403/);
    assert.match(raw, /local access only/);

    // The loopback Host that the real client sends is accepted.
    const ok = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
    assert.equal(ok.status, 200);
  } finally {
    server.close();
    await new Promise((r) => server.once("close", r));
  }
});

test("HTTP: protected and auth responses are not publicly cacheable", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const status = await call("/api/auth/status");
    assert.match(status.headers.get("cache-control"), /no-store/);
    const denied = await call("/api/leads");
    assert.match(denied.headers.get("cache-control"), /no-store/);

    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    const ok = await call("/api/leads", { headers: { Cookie: `${SESSION_COOKIE}=${cookieFrom(login)}` } });
    assert.match(ok.headers.get("cache-control"), /no-store/);
    assert.match(ok.headers.get("vary"), /Cookie/);
  });
});

test("HTTP: before setup, status says so and business routes still disclose nothing", async () => {
  const ctx = buildApp({ seedAdmin: false });
  await withServer(ctx, async (call) => {
    const status = await call("/api/auth/status");
    assert.equal(status.status, 200);
    assert.equal((await status.json()).setupRequired, true);

    const leads = await call("/api/leads");
    assert.equal(leads.status, 401);
    assert.equal((await leads.text()).includes("Secret Co"), false);
  });
});

test("HTTP: setup closes permanently and does not auto-login", async () => {
  const ctx = buildApp({ seedAdmin: false });
  await withServer(ctx, async (call) => {
    const first = await call("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password: GOOD_PASSWORD, confirm_password: GOOD_PASSWORD }),
    });
    assert.equal(first.status, 200);
    // No session handed out by setup itself.
    assert.equal(first.headers.get("set-cookie"), null);

    const second = await call("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password: "another long passphrase", confirm_password: "another long passphrase" }),
    });
    assert.equal(second.status, 409);

    // Setup no longer offered, and the first password still works.
    assert.equal((await (await call("/api/auth/status")).json()).setupRequired, false);
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    assert.equal(login.status, 200);
  });
});

test("HTTP: setup rejects mismatch and out-of-policy length with 400", async () => {
  const ctx = buildApp({ seedAdmin: false });
  await withServer(ctx, async (call) => {
    const mismatch = await call("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password: GOOD_PASSWORD, confirm_password: GOOD_PASSWORD + "x" }),
    });
    assert.equal(mismatch.status, 400);

    const tooShort = await call("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password: "tiny", confirm_password: "tiny" }),
    });
    assert.equal(tooShort.status, 400);

    assert.equal((await (await call("/api/auth/status")).json()).setupRequired, true);
  });
});

test("HTTP: an expired session reports reason 'expired' so the UI can say so", async () => {
  const clock = fakeClock();
  const ctx = buildApp({ seedAdmin: true, clock });
  await withServer(ctx, async (call) => {
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    const cookie = `${SESSION_COOKIE}=${cookieFrom(login)}`;
    clock.advance(POLICY.idleMs + 1000);
    const res = await call("/api/leads", { headers: { Cookie: cookie } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).reason, "expired");
    // And the dead cookie is cleared from the browser.
    assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
  });
});

test("HTTP: an unavailable auth store returns 503, never an open door", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    const cookie = `${SESSION_COOKIE}=${cookieFrom(login)}`;
    ctx.db.exec("DROP TABLE auth_sessions"); // store goes away mid-flight

    const protectedRes = await call("/api/leads", { headers: { Cookie: cookie } });
    assert.equal(protectedRes.status, 503);
    assert.equal((await protectedRes.text()).includes("Secret Co"), false);

    const status = await call("/api/auth/status");
    assert.equal(status.status, 503);
  });
});

test("HTTP: logout failure does not report success", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    const cookie = `${SESSION_COOKIE}=${cookieFrom(login)}`;
    ctx.db.exec("DROP TABLE auth_sessions");
    const out = await call("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
    assert.equal(out.status, 503);
    assert.equal((await out.json()).ok, undefined);
    // The browser's cookie is still cleared — it loses its handle regardless.
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  });
});

// ---------------------------------------------------------------- recovery

// Recovery lives in recover-admin.js, which is interactive by design. These
// tests exercise the state transition it performs, which is the part that must
// be fail-closed: the semantics, not the prompting.

test("recovery: resetting the password keeps exactly one admin and kills sessions", () => {
  const { auth, db } = freshAuth();
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  const oldToken = auth.login({ username: "admin", password: GOOD_PASSWORD }).token;

  // What recover-admin.js does.
  const NEW_PASSWORD = "a brand new recovery passphrase";
  db.prepare("UPDATE auth_admin SET password_hash = ? WHERE id = 1").run(auth.hashPassword(NEW_PASSWORD));
  auth.destroyAllSessions();
  auth.clearFailures();

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_admin").get().n, 1);
  assert.equal(auth.resolveSession(oldToken).valid, false, "pre-reset session must not survive");
  assert.equal(auth.login({ username: "admin", password: GOOD_PASSWORD }).ok, false, "old password must stop working");
  assert.equal(auth.login({ username: "admin", password: NEW_PASSWORD }).ok, true);
});

test("recovery: an active lockout does not block the recovered password", () => {
  const clock = fakeClock();
  const { auth, db } = freshAuth(clock);
  auth.createAdmin(GOOD_PASSWORD, GOOD_PASSWORD);
  for (let i = 0; i < POLICY.maxFailures; i++) auth.login({ username: "admin", password: "wrong password value" });
  assert.equal(auth.throttleState().locked, true);

  const NEW_PASSWORD = "a brand new recovery passphrase";
  db.prepare("UPDATE auth_admin SET password_hash = ? WHERE id = 1").run(auth.hashPassword(NEW_PASSWORD));
  auth.destroyAllSessions();
  auth.clearFailures(); // recovery clears the cooldown too

  assert.equal(auth.throttleState().locked, false);
  assert.equal(auth.login({ username: "admin", password: NEW_PASSWORD }).ok, true);
});

test("recovery: there is no HTTP route that can reset a password", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    // Any plausible reset endpoint must not exist as a public bypass. Each of
    // these is either unknown (404) or caught by the gate (401) — never a 200.
    const candidates = [
      "/api/auth/recover",
      "/api/auth/reset",
      "/api/auth/reset-password",
      "/api/auth/forgot",
      "/api/auth/admin",
    ];
    for (const path of candidates) {
      const res = await call(path, { method: "POST", body: JSON.stringify({ password: GOOD_PASSWORD }) });
      assert.ok(res.status === 404 || res.status === 401, `${path} answered ${res.status}`);
    }
  });
});

test("recovery: setup cannot be reused as a reset once an admin exists", async () => {
  const ctx = buildApp({ seedAdmin: true });
  await withServer(ctx, async (call) => {
    const res = await call("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password: "attacker chosen passphrase", confirm_password: "attacker chosen passphrase" }),
    });
    assert.equal(res.status, 409);
    // The original password is untouched.
    const login = await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: GOOD_PASSWORD }),
    });
    assert.equal(login.status, 200);
  });
});
