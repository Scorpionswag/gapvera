// Tests for the hand-written Supabase client's session handling.
//
// Run: node --test client/src/supabase.test.mjs
//
// This file exists because the auth layer was written by hand instead of using
// @supabase/supabase-js, so the parts a library would have gotten right are
// now mine to get right. The cases below are the ones that cause real damage:
//
//   * A concurrent refresh storm destroying a valid session (GoTrue rotates
//     the refresh token on use, so a second request presenting the consumed
//     token logs the user out).
//   * A request going out with no Authorization header and being treated as
//     success.
//   * A 401 leaving the UI in a logged-in-looking state.
//
// localStorage, fetch, window and CustomEvent are stubbed, because the module
// is written against those globals and the point is to test it as shipped.

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Environment stubs, installed before the module under test is imported
// ---------------------------------------------------------------------------

function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    _map: map,
  };
}

const events = [];

globalThis.localStorage = makeLocalStorage();
globalThis.window = {
  dispatchEvent: (e) => events.push(e),
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

// The module reads its config at import time, so these must be set first.
globalThis.__TEST_ENV__ = {
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_ANON_KEY: "anon-key-for-tests",
};

// Records every outgoing request so assertions can inspect headers.
let calls = [];
let handler = null;

globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, options });
  if (!handler) throw new Error(`unexpected fetch: ${url}`);
  return handler(url, options);
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const { supaAuth, db, AUTH_LOST_EVENT, isConfigured } = await import("./supabase.js");

function reset() {
  localStorage.clear();
  calls = [];
  events.length = 0;
  handler = null;
}

const SESSION_KEY = "gapvera.session";
const futureSession = (secondsAhead = 3600) => ({
  access_token: "access-live",
  refresh_token: "refresh-live",
  expires_at: Math.floor(Date.now() / 1000) + secondsAhead,
  user: { id: "user-1", email: "erik@example.com" },
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("isConfigured is true when both env values are present", () => {
  assert.equal(isConfigured, true);
});

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

test("signIn stores the session and never stores the password", async () => {
  reset();
  handler = async () =>
    jsonResponse(200, {
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
      user: { id: "user-1", email: "erik@example.com" },
    });

  await supaAuth.signIn("erik@example.com", "correct horse battery staple");

  const stored = JSON.parse(localStorage.getItem(SESSION_KEY));
  assert.equal(stored.access_token, "access-new");
  assert.equal(stored.user.email, "erik@example.com");
  // The whole serialized blob must not contain the password anywhere.
  assert.ok(!JSON.stringify(stored).includes("correct horse battery staple"));
  // expires_in must have been converted to an absolute expiry.
  assert.ok(stored.expires_at > Math.floor(Date.now() / 1000));
});

test("signIn surfaces the provider's error and stores nothing on failure", async () => {
  reset();
  handler = async () => jsonResponse(400, { error_description: "Invalid login credentials" });

  await assert.rejects(() => supaAuth.signIn("erik@example.com", "wrong"), /Invalid login credentials/);
  assert.equal(localStorage.getItem(SESSION_KEY), null);
});

// ---------------------------------------------------------------------------
// Token use
// ---------------------------------------------------------------------------

test("a data call sends the access token and the apikey", async () => {
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () => jsonResponse(200, []);

  await db.select("leads");

  const { options } = calls[0];
  assert.equal(options.headers.Authorization, "Bearer access-live");
  assert.equal(options.headers.apikey, "anon-key-for-tests");
});

test("with no session, a data call sends NO Authorization header", async () => {
  // This is the fail-closed contract: PostgREST then applies the anon role,
  // whose grants were revoked, so the server refuses it. The client must not
  // invent a header or skip the request.
  reset();
  handler = async () => jsonResponse(200, []);

  await db.select("leads");

  const { options } = calls[0];
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.headers.apikey, "anon-key-for-tests");
});

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

test("an expired token is refreshed before the data call goes out", async () => {
  reset();
  // Already past expiry.
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession(-10)));

  handler = async (url) => {
    if (String(url).includes("grant_type=refresh_token")) {
      return jsonResponse(200, {
        access_token: "access-refreshed",
        refresh_token: "refresh-rotated",
        expires_in: 3600,
        user: { id: "user-1", email: "erik@example.com" },
      });
    }
    return jsonResponse(200, []);
  };

  await db.select("leads");

  assert.ok(String(calls[0].url).includes("grant_type=refresh_token"));
  // The data call must carry the NEW token, not the stale one.
  assert.equal(calls[1].options.headers.Authorization, "Bearer access-refreshed");
  // And the rotated refresh token must be persisted, or the next refresh
  // presents a consumed token.
  assert.equal(JSON.parse(localStorage.getItem(SESSION_KEY)).refresh_token, "refresh-rotated");
});

test("a token inside the refresh skew window is refreshed proactively", async () => {
  // 30s from expiry, inside the 60s skew: a request that takes a moment would
  // otherwise race the token's death mid-flight.
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession(30)));

  let refreshes = 0;
  handler = async (url) => {
    if (String(url).includes("grant_type=refresh_token")) {
      refreshes++;
      return jsonResponse(200, {
        access_token: "access-refreshed",
        refresh_token: "refresh-rotated",
        expires_in: 3600,
      });
    }
    return jsonResponse(200, []);
  };

  await db.select("leads");
  assert.equal(refreshes, 1);
});

test("concurrent calls on an expired token trigger exactly ONE refresh", async () => {
  // The bug this guards: six parallel queries on page mount each start a
  // refresh. GoTrue rotates the refresh token on use, so five of them present
  // an already-consumed token and the session is destroyed by its own success.
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession(-10)));

  let refreshes = 0;
  handler = async (url) => {
    if (String(url).includes("grant_type=refresh_token")) {
      refreshes++;
      // Yield, so all six callers are genuinely in flight at once.
      await new Promise((r) => setTimeout(r, 10));
      return jsonResponse(200, {
        access_token: "access-refreshed",
        refresh_token: "refresh-rotated",
        expires_in: 3600,
      });
    }
    return jsonResponse(200, []);
  };

  await Promise.all([
    db.select("leads"),
    db.select("clients"),
    db.select("calls"),
    db.select("invoices"),
    db.select("documents"),
    db.select("email_templates"),
  ]);

  assert.equal(refreshes, 1);
  // Every data call must have used the refreshed token.
  const dataCalls = calls.filter((c) => String(c.url).includes("/rest/v1/"));
  assert.equal(dataCalls.length, 6);
  for (const c of dataCalls) {
    assert.equal(c.options.headers.Authorization, "Bearer access-refreshed");
  }
});

test("a failed refresh clears the session and announces auth loss", async () => {
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession(-10)));
  handler = async () => jsonResponse(400, { error: "invalid_grant" });

  await assert.rejects(() => db.select("leads"));

  // A dead session must not survive in storage — on reload it would otherwise
  // produce a logged-in-looking UI with no access to anything.
  assert.equal(localStorage.getItem(SESSION_KEY), null);
  assert.equal(events.at(-1).type, AUTH_LOST_EVENT);
  assert.equal(events.at(-1).detail.reason, "expired");
});

// ---------------------------------------------------------------------------
// Fail-closed on rejection
// ---------------------------------------------------------------------------

test("a 401 on a data call clears the session and announces auth loss", async () => {
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () => jsonResponse(401, { message: "JWT expired" });

  await assert.rejects(() => db.select("leads"), /expired/i);
  assert.equal(localStorage.getItem(SESSION_KEY), null);
  assert.equal(events.at(-1).detail.reason, "expired");
});

test("a 403 is treated as lost authorization, not a transient error", async () => {
  // PostgREST answers 403 when the role lost its grants. Retrying would just
  // fail again; the UI must stop presenting itself as authorized.
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () => jsonResponse(403, { message: "permission denied for table leads" });

  await assert.rejects(() => db.select("leads"), /Access denied/);
  assert.equal(localStorage.getItem(SESSION_KEY), null);
  assert.equal(events.at(-1).detail.reason, "forbidden");
});

test("a 500 does NOT clear the session", async () => {
  // A server fault is not an authorization failure. Logging the user out on a
  // transient 500 would be its own bug.
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () => jsonResponse(500, { message: "internal error" });

  await assert.rejects(() => db.select("leads"), /internal error/);
  assert.ok(localStorage.getItem(SESSION_KEY), "session should survive a 500");
});

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

test("signOut clears local storage even when the network call fails", async () => {
  // If revocation can't be reached, the browser must still end up signed out.
  // Keeping a live token because the server was unreachable is the wrong
  // failure direction.
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () => {
    throw new Error("network down");
  };

  await supaAuth.signOut();
  assert.equal(localStorage.getItem(SESSION_KEY), null);
});

test("signOut revokes the token server-side when it can", async () => {
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () => jsonResponse(204, {});

  await supaAuth.signOut();

  const logout = calls.find((c) => String(c.url).includes("/auth/v1/logout"));
  assert.ok(logout, "should call the logout endpoint");
  assert.equal(logout.options.headers.Authorization, "Bearer access-live");
  assert.equal(localStorage.getItem(SESSION_KEY), null);
});

// ---------------------------------------------------------------------------
// Owner verification
// ---------------------------------------------------------------------------

test("verify reports isOwner false when app_owner has no matching row", async () => {
  // Signed in but not the owner. Every table correctly returns nothing, and
  // the app must distinguish this from a bad password.
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return jsonResponse(200, { id: "user-1", email: "erik@example.com" });
    }
    return jsonResponse(200, []); // empty app_owner result
  };

  const result = await supaAuth.verify();
  assert.equal(result.authenticated, true);
  assert.equal(result.isOwner, false);
});

test("verify reports isOwner true when app_owner returns the user's row", async () => {
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return jsonResponse(200, { id: "user-1", email: "erik@example.com" });
    }
    return jsonResponse(200, [{ user_id: "user-1" }]);
  };

  const result = await supaAuth.verify();
  assert.equal(result.authenticated, true);
  assert.equal(result.isOwner, true);
});

// ---------------------------------------------------------------------------
// Unprovisioned backend (the production incident of 2026-11-06)
//
// The live site reached Supabase, signed the user in, then showed
// "Could not find the table 'public.app_owner' in the schema cache" on the
// login form. The database migration had never been applied. Three things
// were wrong, and each is pinned below:
//   * a provisioning fault was reported as a credential failure;
//   * raw PostgREST internals (table names, PGRST codes) reached the UI;
//   * sign-in had already succeeded, so a live token was left in storage.
// ---------------------------------------------------------------------------

const SCHEMA_MISSING_BODY = {
  code: "PGRST205",
  message: "Could not find the table 'public.app_owner' in the schema cache",
};

test("verify flags a missing app_owner table as a provisioning fault, not a login failure", async () => {
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async (url) => {
    if (String(url).includes("/auth/v1/user")) {
      return jsonResponse(200, { id: "user-1", email: "erik@example.com" });
    }
    return jsonResponse(404, SCHEMA_MISSING_BODY);
  };

  const result = await supaAuth.verify();

  // The credentials were genuinely accepted — saying otherwise sends the
  // operator to retype a working password.
  assert.equal(result.authenticated, true);
  assert.equal(result.schemaMissing, true);
  // Fail closed: ownership is undecidable, so it is not granted.
  assert.equal(result.isOwner, false);
});

test("a missing table does not clear the session (a valid token is not the fault)", async () => {
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () => jsonResponse(404, SCHEMA_MISSING_BODY);

  await assert.rejects(() => db.select("leads"));

  assert.ok(localStorage.getItem(SESSION_KEY), "session must survive a 404");
  assert.equal(
    events.filter((e) => e.type === AUTH_LOST_EVENT).length,
    0,
    "a provisioning fault must not fire auth-lost"
  );
});

test("a schema-missing error does not leak PostgREST internals into its message", async () => {
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () => jsonResponse(404, SCHEMA_MISSING_BODY);

  const err = await db.select("leads").then(
    () => assert.fail("should reject"),
    (e) => e
  );

  assert.equal(err.schemaMissing, true);
  // The diagnostic code stays available to code; the human-facing string must
  // not carry the table name or the PGRST code.
  assert.equal(err.pgCode, "PGRST205");
  assert.doesNotMatch(err.message, /app_owner|schema cache|PGRST/i);
});

test("a missing RPC (PGRST202) is also treated as unprovisioned", async () => {
  // is_owner() lives in the same migration as app_owner; if one is absent the
  // other is too, and both must route to the same explanation.
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () =>
    jsonResponse(404, {
      code: "PGRST202",
      message: "Could not find the function public.is_owner without parameters in the schema cache",
    });

  const err = await db.raw("/rpc/is_owner", { method: "POST" }).then(
    () => assert.fail("should reject"),
    (e) => e
  );
  assert.equal(err.schemaMissing, true);
});

test("an ordinary 404 is NOT treated as unprovisioned", async () => {
  // Only PostgREST's schema-cache codes mean the migration is missing. A bare
  // 404 must keep its normal error path rather than claiming the database is
  // unbuilt.
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify(futureSession()));
  handler = async () => jsonResponse(404, { message: "nope" });

  const err = await db.select("leads").then(
    () => assert.fail("should reject"),
    (e) => e
  );
  assert.notEqual(err.schemaMissing, true);
});

test("verify returns unauthenticated with no stored session, without a network call", async () => {
  reset();
  const result = await supaAuth.verify();
  assert.equal(result.authenticated, false);
  assert.equal(calls.length, 0);
});

test("verify treats a corrupt stored session as no session", async () => {
  reset();
  localStorage.setItem(SESSION_KEY, "{not json at all");
  const result = await supaAuth.verify();
  assert.equal(result.authenticated, false);
});

test("verify treats a session missing its refresh token as no session", async () => {
  // Half-written storage must not be trusted enough to attempt a call with.
  reset();
  localStorage.setItem(SESSION_KEY, JSON.stringify({ access_token: "a" }));
  const result = await supaAuth.verify();
  assert.equal(result.authenticated, false);
});
