// Single local administrator authentication for GapVera.
//
// Design constraints this file encodes (handoff: spec.md / decisions.md):
//   - exactly one admin identity, fixed username `admin`, created atomically
//   - opaque server-side sessions; nothing authenticating lives in the browser
//     beyond an HttpOnly cookie, and the DB stores only a hash of the token
//   - fail closed: if the auth store is unavailable we deny, we never fall back
//     to "looks like a fresh install"
//
// It takes the database handle as an argument rather than importing db.js so
// the policy can be exercised against any SQLite handle exposing the
// prepare()/exec() subset (better-sqlite3 in production, node:sqlite in tests).
// Nothing here uses better-sqlite3-only helpers (.pragma/.transaction).

import crypto from "crypto";

export const ADMIN_USERNAME = "admin";

// Approved policy values. Exported so routes, tests and the client can agree on
// one definition instead of re-stating numbers.
export const POLICY = {
  passwordMin: 15,
  passwordMax: 128,
  idleMs: 30 * 60 * 1000, // 30-minute inactivity window
  absoluteMs: 12 * 60 * 60 * 1000, // 12-hour hard ceiling
  maxFailures: 5, // failures tolerated...
  failureWindowMs: 15 * 60 * 1000, // ...within this window...
  cooldownMs: 15 * 60 * 1000, // ...before this cooldown applies
};

export const SESSION_COOKIE = "gv_session";

// scrypt parameters. N=2^15 with r=8 is ~33MB and ~100ms per hash on a laptop:
// deliberately slow for a local-only login, cheap enough not to be a DoS lever
// on the five attempts the throttle allows. maxmem must be raised explicitly
// because Node's 32MB default sits just under what these parameters need.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

export class AuthStoreUnavailable extends Error {
  constructor(cause) {
    super("auth store unavailable");
    this.name = "AuthStoreUnavailable";
    this.cause = cause;
  }
}

/**
 * Create the auth tables and return the auth API bound to this database.
 * Throws AuthStoreUnavailable if the store cannot be initialized — callers must
 * treat that as "deny everything", never as "no admin exists yet".
 */
export function createAuth(db, options = {}) {
  const now = options.now || (() => Date.now());

  try {
    db.exec(`
      -- CHECK (id = 1) with a primary key is what makes "exactly one admin"
      -- a database invariant rather than an application convention: a second
      -- INSERT fails atomically, including under concurrent setup requests.
      CREATE TABLE IF NOT EXISTS auth_admin (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Only the SHA-256 of the session token is stored, so a copy of the
      -- database (or a backup) yields nothing that can be replayed as a cookie.
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        failed_at INTEGER NOT NULL
      );

      -- The cooldown is persisted rather than derived from the failure window.
      -- Deriving it is subtly wrong: as the 15-minute window slides, the early
      -- failures age out, the count drops back under the limit and the lockout
      -- would release itself early. Once tripped, the cooldown runs its full
      -- term from the last failure.
      CREATE TABLE IF NOT EXISTS auth_lockout (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        until INTEGER NOT NULL
      );
    `);
  } catch (err) {
    throw new AuthStoreUnavailable(err);
  }

  const q = {
    admin: db.prepare("SELECT * FROM auth_admin WHERE id = 1"),
    insertAdmin: db.prepare(
      "INSERT INTO auth_admin (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)"
    ),
    session: db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?"),
    insertSession: db.prepare(
      "INSERT INTO auth_sessions (token_hash, created_at, last_seen_at) VALUES (?, ?, ?)"
    ),
    touchSession: db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?"),
    deleteSession: db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?"),
    deleteAllSessions: db.prepare("DELETE FROM auth_sessions"),
    recentFailures: db.prepare(
      "SELECT COUNT(*) AS n, MAX(failed_at) AS last FROM auth_failures WHERE failed_at > ?"
    ),
    insertFailure: db.prepare("INSERT INTO auth_failures (failed_at) VALUES (?)"),
    clearFailures: db.prepare("DELETE FROM auth_failures"),
    pruneFailures: db.prepare("DELETE FROM auth_failures WHERE failed_at <= ?"),
    lockout: db.prepare("SELECT until FROM auth_lockout WHERE id = 1"),
    setLockout: db.prepare(
      "INSERT INTO auth_lockout (id, until) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET until = excluded.until"
    ),
    clearLockout: db.prepare("DELETE FROM auth_lockout"),
  };

  // Any failure to read the auth store is an availability problem, not an
  // answer. Surfacing it as a distinct error keeps the "fail closed" promise
  // honest at every call site instead of degrading into a falsy result.
  const guard = (fn) => {
    try {
      return fn();
    } catch (err) {
      throw new AuthStoreUnavailable(err);
    }
  };

  const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

  function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
    return [
      "scrypt",
      SCRYPT.N,
      SCRYPT.r,
      SCRYPT.p,
      salt.toString("base64"),
      derived.toString("base64"),
    ].join("$");
  }

  function verifyPassword(password, stored) {
    try {
      const [scheme, N, r, p, saltB64, hashB64] = String(stored).split("$");
      if (scheme !== "scrypt") return false;
      const salt = Buffer.from(saltB64, "base64");
      const expected = Buffer.from(hashB64, "base64");
      const derived = crypto.scryptSync(password.normalize("NFKC"), salt, expected.length, {
        N: Number(N),
        r: Number(r),
        p: Number(p),
        maxmem: SCRYPT.maxmem,
      });
      return crypto.timingSafeEqual(derived, expected);
    } catch {
      return false;
    }
  }

  /**
   * Password policy check. Length is counted in Unicode code points, not UTF-16
   * units, so an emoji or accented character costs one character to the user and
   * one character to the validator. Spaces are deliberately legal and never
   * trimmed — a passphrase's spaces are part of the secret.
   */
  function checkPassword(password) {
    if (typeof password !== "string") return { ok: false, reason: "invalid" };
    const length = [...password].length;
    if (length < POLICY.passwordMin || length > POLICY.passwordMax) {
      return {
        ok: false,
        reason: "length",
        message: `Password must be ${POLICY.passwordMin}–${POLICY.passwordMax} characters.`,
      };
    }
    return { ok: true };
  }

  const adminExists = () => guard(() => !!q.admin.get());

  /**
   * Create the one admin. Returns {ok:false, reason:"exists"} for every attempt
   * after the first, including a request that races the first one: the unique
   * primary key, not a prior read, is what rejects it.
   */
  function createAdmin(password, confirmation) {
    if (password !== confirmation) return { ok: false, reason: "mismatch", message: "Passwords do not match." };
    const policy = checkPassword(password);
    if (!policy.ok) return { ok: false, reason: policy.reason, message: policy.message };
    if (adminExists()) return { ok: false, reason: "exists", message: "An administrator already exists." };

    const hash = hashPassword(password);
    try {
      q.insertAdmin.run(ADMIN_USERNAME, hash, now());
    } catch (err) {
      // Lost the race, or the row is otherwise already present.
      if (guard(() => !!q.admin.get())) {
        return { ok: false, reason: "exists", message: "An administrator already exists." };
      }
      throw new AuthStoreUnavailable(err);
    }
    return { ok: true, username: ADMIN_USERNAME };
  }

  // ---------- throttling ----------

  /**
   * Five failures inside the 15-minute window start a 15-minute cooldown, timed
   * from the most recent failure and recorded explicitly so a sliding window
   * cannot release it early. Tracked server-side; a client cannot see or reset
   * it. Scope is the single admin account, which is the whole login surface
   * here — there is no per-IP dimension to bypass.
   */
  function throttleState() {
    const at = now();
    const lock = guard(() => q.lockout.get());
    if (lock && at < lock.until) {
      return { locked: true, retryAfterMs: lock.until - at, failures: POLICY.maxFailures };
    }
    if (lock) {
      // Cooldown served: clear it and the failures that caused it, so the
      // operator starts from a clean slate rather than one strike from re-lock.
      guard(() => q.clearLockout.run());
      guard(() => q.clearFailures.run());
      return { locked: false, retryAfterMs: 0, failures: 0 };
    }
    const { n } = guard(() => q.recentFailures.get(at - POLICY.failureWindowMs)) || { n: 0 };
    return { locked: false, retryAfterMs: 0, failures: n };
  }

  function recordFailure() {
    const at = now();
    guard(() => q.insertFailure.run(at));
    const { n } = guard(() => q.recentFailures.get(at - POLICY.failureWindowMs)) || { n: 0 };
    // Tripping the limit starts the cooldown from this failure.
    if (n >= POLICY.maxFailures) guard(() => q.setLockout.run(at + POLICY.cooldownMs));
  }

  function clearFailures() {
    guard(() => q.clearFailures.run());
    guard(() => q.clearLockout.run());
  }

  // ---------- sessions ----------

  function issueSession() {
    const token = crypto.randomBytes(32).toString("base64url");
    const at = now();
    guard(() => q.insertSession.run(sha256(token), at, at));
    return token;
  }

  function destroySession(token) {
    if (!token) return false;
    const info = guard(() => q.deleteSession.run(sha256(token)));
    return (info?.changes || 0) > 0;
  }

  const destroyAllSessions = () => guard(() => q.deleteAllSessions.run());

  /**
   * Resolve a cookie token to a live session, sliding the idle window forward.
   * Expiry is evaluated here rather than by a sweep, so an idle or aged-out
   * session is dead the moment it is next presented even if no cleanup ran.
   */
  function resolveSession(token) {
    if (!token || typeof token !== "string") return { valid: false, reason: "missing" };
    const hash = sha256(token);
    const row = guard(() => q.session.get(hash));
    if (!row) return { valid: false, reason: "unknown" };

    const at = now();
    if (at - row.last_seen_at > POLICY.idleMs) {
      guard(() => q.deleteSession.run(hash));
      return { valid: false, reason: "idle" };
    }
    if (at - row.created_at > POLICY.absoluteMs) {
      guard(() => q.deleteSession.run(hash));
      return { valid: false, reason: "absolute" };
    }
    guard(() => q.touchSession.run(at, hash));
    return { valid: true, username: ADMIN_USERNAME, role: "admin", createdAt: row.created_at };
  }

  /**
   * Verify credentials and, on success, mint a brand-new session. The caller
   * passes the presented cookie so the previous identifier is destroyed in the
   * same step — rotation, not accumulation.
   */
  function login({ username, password, currentToken }) {
    const throttle = throttleState();
    if (throttle.locked) return { ok: false, reason: "throttled", retryAfterMs: throttle.retryAfterMs };

    const admin = guard(() => q.admin.get());
    // Verify against a dummy hash when there is no admin (or the username is
    // wrong) so the response time does not reveal which case it was.
    const stored = admin ? admin.password_hash : DUMMY_HASH;
    const nameOk = typeof username === "string" && username.trim().toLowerCase() === ADMIN_USERNAME;
    const passOk = verifyPassword(typeof password === "string" ? password : "", stored);

    if (!admin || !nameOk || !passOk) {
      recordFailure();
      const after = throttleState();
      return { ok: false, reason: "invalid", retryAfterMs: after.retryAfterMs };
    }

    destroySession(currentToken);
    clearFailures();
    return { ok: true, token: issueSession(), username: ADMIN_USERNAME, role: "admin" };
  }

  /**
   * Bootstrap state for an unauthenticated client. Deliberately minimal: whether
   * setup is needed, whether this request carries a live session, and the
   * password rule the form must mirror. No configuration, no record counts, no
   * hint about why a session is missing.
   *
   * Both auth tables are probed even when no cookie is present: a readable
   * admin row plus an unreadable session table means nobody can ever log in,
   * and the client must be told the store is broken rather than handed a login
   * form that cannot work.
   */
  function status(token) {
    const setupRequired = !adminExists();
    guard(() => q.session.get("")); // reachability probe, not a lookup
    const session = token ? resolveSession(token) : { valid: false, reason: "missing" };
    return {
      setupRequired,
      authenticated: session.valid,
      username: session.valid ? ADMIN_USERNAME : null,
      passwordPolicy: { min: POLICY.passwordMin, max: POLICY.passwordMax },
    };
  }

  // Sessions do not survive a restart (approved v1 behavior): the process that
  // minted them is gone, so every token presented afterwards is rejected.
  const prune = () => guard(() => q.pruneFailures.run(now() - POLICY.failureWindowMs));

  return {
    POLICY,
    ADMIN_USERNAME,
    adminExists,
    createAdmin,
    checkPassword,
    verifyPassword,
    hashPassword,
    login,
    status,
    resolveSession,
    issueSession,
    destroySession,
    destroyAllSessions,
    throttleState,
    recordFailure,
    clearFailures,
    prune,
  };
}

// A real scrypt hash of a random value, used only to keep the no-admin and
// wrong-password paths doing the same work. Never matches any input.
const DUMMY_HASH = (() => {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(crypto.randomBytes(32).toString("hex"), salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), derived.toString("base64")].join("$");
})();
