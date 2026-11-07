// Tests for the auth orchestration in api.js — the layer that turns
// supaAuth.verify()'s raw result into the phase the app shell renders.
//
// Run: node --test client/src/authFlow.test.mjs
//
// Why this file exists: the production incident of 2026-11-06. Sign-in at
// https://gapvera.pages.dev succeeded against Supabase Auth, then the login
// form showed:
//
//   Could not find the table 'public.app_owner' in the schema cache
//
// The database migration had never been applied to the project. supabase.js
// owns detecting that (see supabase.test.mjs); this file owns what api.js
// does about it. Three separate defects, one per test group below:
//
//   1. STATE. An unprovisioned backend was indistinguishable from a wrong
//      password, so the only available action was to retype a password that
//      was already correct.
//   2. TOKEN HYGIENE. auth.login() signs in BEFORE it verifies ownership. Any
//      throw after the sign-in left a live session in localStorage while the
//      UI showed a login form — a reload would then walk straight into the
//      broken state with a token the user never knowingly kept.
//   3. LEAKAGE. Raw PostgREST text (table names, PGRST codes) reached a
//      login screen a browser renders publicly.
//
// supabase.js is stubbed rather than driven through fetch: the unit under test
// is api.js's decision logic, and supabase.test.mjs already covers the
// transport beneath it.

import test from "node:test";
import assert from "node:assert/strict";

// api.js imports supabase.js, which reads its config and touches these globals
// at import time. They must exist before the dynamic import below.
function makeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

globalThis.localStorage = makeLocalStorage();
globalThis.window = {
  dispatchEvent: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};
globalThis.__TEST_ENV__ = {
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_ANON_KEY: "anon-key-for-tests",
};

const SESSION_KEY = "gapvera.session";

// A real-shaped stored session, so "was the token cleared?" is a genuine check
// rather than an assertion about an already-empty store.
const LIVE_SESSION = JSON.stringify({
  access_token: "access-live",
  refresh_token: "refresh-live",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "user-1", email: "erik@example.com" },
});

const supabase = await import("./supabase.js");
const { auth } = await import("./api.js");

// supaAuth is a frozen-in-practice object literal; swapping its methods per
// test is enough to drive api.js, and restoring them keeps tests independent.
const realVerify = supabase.supaAuth.verify;
const realSignIn = supabase.supaAuth.signIn;
const realSignOut = supabase.supaAuth.signOut;

let signOutCalls = 0;

function stub({ signIn, verify }) {
  signOutCalls = 0;
  supabase.supaAuth.signIn = signIn || (async () => ({ access_token: "access-live" }));
  supabase.supaAuth.verify = verify;
  supabase.supaAuth.signOut = async () => {
    signOutCalls++;
    localStorage.removeItem(SESSION_KEY);
  };
}

test.afterEach(() => {
  supabase.supaAuth.verify = realVerify;
  supabase.supaAuth.signIn = realSignIn;
  supabase.supaAuth.signOut = realSignOut;
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// 1. State: unprovisioned is its own outcome
// ---------------------------------------------------------------------------

test("login against an unprovisioned backend reports a provisioning fault", async () => {
  stub({
    verify: async () => ({ authenticated: true, isOwner: false, schemaMissing: true }),
  });

  const err = await auth.login("erik@example.com", "correct-password").then(
    () => assert.fail("should reject"),
    (e) => e
  );

  // The flag is what the app shell branches on. Without it this is
  // indistinguishable from a non-owner or a bad password.
  assert.equal(err.backendNotProvisioned, true);
  // And it must NOT be dressed up as an authorization decision: the account
  // may well be the owner; the table that would say so does not exist.
  assert.notEqual(err.notAuthorized, true);
});

test("status() reports an unprovisioned backend without claiming a login problem", async () => {
  localStorage.setItem(SESSION_KEY, LIVE_SESSION);
  stub({
    verify: async () => ({ authenticated: true, isOwner: false, schemaMissing: true }),
  });

  const status = await auth.status();

  assert.equal(status.backendNotProvisioned, true);
  // Fail closed — no workspace.
  assert.equal(status.authenticated, false);
  // Critically NOT authenticatedNotOwner: that screen says "this account
  // can't open GapVera", which would be a false statement about the account.
  assert.equal(status.authenticatedNotOwner, false);
});

// ---------------------------------------------------------------------------
// 2. Token hygiene: no live session behind a login form
// ---------------------------------------------------------------------------

test("a failed login against an unprovisioned backend leaves no stored session", async () => {
  stub({
    signIn: async () => {
      // Mirrors reality: GoTrue succeeded and wrote a session before the
      // ownership check ran.
      localStorage.setItem(SESSION_KEY, LIVE_SESSION);
      return { access_token: "access-live" };
    },
    verify: async () => ({ authenticated: true, isOwner: false, schemaMissing: true }),
  });

  await assert.rejects(() => auth.login("erik@example.com", "correct-password"));

  assert.equal(
    localStorage.getItem(SESSION_KEY),
    null,
    "a live token must not survive behind a login screen"
  );
  assert.equal(signOutCalls, 1, "the session must be revoked server-side too");
});

test("an unexpected error during verification also clears the session", async () => {
  // The general case of the same class: any throw after sign-in must not leave
  // a token behind, not just the schema-missing one.
  stub({
    signIn: async () => {
      localStorage.setItem(SESSION_KEY, LIVE_SESSION);
      return { access_token: "access-live" };
    },
    verify: async () => {
      throw new Error("network died mid-verify");
    },
  });

  await assert.rejects(() => auth.login("erik@example.com", "correct-password"), /network died/);

  assert.equal(localStorage.getItem(SESSION_KEY), null);
});

// ---------------------------------------------------------------------------
// 3. Leakage: no database internals on a public login screen
// ---------------------------------------------------------------------------

test("the login error names no table, schema, or PostgREST code", async () => {
  stub({
    verify: async () => ({ authenticated: true, isOwner: false, schemaMissing: true }),
  });

  const err = await auth.login("erik@example.com", "correct-password").then(
    () => assert.fail("should reject"),
    (e) => e
  );

  assert.doesNotMatch(err.message, /app_owner|schema cache|PGRST|public\./i);
  // It still has to be actionable rather than a shrug.
  assert.match(err.message, /set up|provision|not ready|database/i);
});

// ---------------------------------------------------------------------------
// Regression guard: the real non-owner path must still behave as before
// ---------------------------------------------------------------------------

test("a genuine non-owner is still signed out and told they are not authorized", async () => {
  stub({
    signIn: async () => {
      localStorage.setItem(SESSION_KEY, LIVE_SESSION);
      return { access_token: "access-live" };
    },
    // Provisioned fine; this account simply is not in app_owner.
    verify: async () => ({ authenticated: true, isOwner: false }),
  });

  const err = await auth.login("someone@example.com", "their-password").then(
    () => assert.fail("should reject"),
    (e) => e
  );

  assert.match(err.message, /not authorized/i);
  assert.notEqual(err.backendNotProvisioned, true);
  assert.equal(localStorage.getItem(SESSION_KEY), null);
  assert.equal(signOutCalls, 1);
});

test("the owner still gets in", async () => {
  stub({
    verify: async () => ({
      authenticated: true,
      isOwner: true,
      user: { id: "user-1", email: "erik@example.com" },
    }),
  });

  const result = await auth.login("erik@example.com", "correct-password");
  assert.equal(result.authenticated, true);
  assert.equal(result.user.email, "erik@example.com");
  assert.equal(signOutCalls, 0);
});

test("status() still reports a provisioned owner as authenticated", async () => {
  localStorage.setItem(SESSION_KEY, LIVE_SESSION);
  stub({
    verify: async () => ({
      authenticated: true,
      isOwner: true,
      user: { id: "user-1", email: "erik@example.com" },
    }),
  });

  const status = await auth.status();
  assert.equal(status.authenticated, true);
  assert.equal(status.backendNotProvisioned, false);
  assert.equal(status.authenticatedNotOwner, false);
});
