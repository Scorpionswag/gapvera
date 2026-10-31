// HTTP plumbing for single-admin auth: cookie handling, loopback and
// same-origin enforcement, the auth endpoints, and the gate itself.
//
// The gate is positional, not per-route. installAuth() registers the public
// endpoints and then returns requireAdmin, which index.js mounts once before
// any business route is declared. Express runs middleware in registration
// order, so every route below that line — including routes added in future —
// is protected by default. Nothing has to be remembered or annotated, and
// forgetting to tag a new endpoint cannot open a hole.

import { AuthStoreUnavailable, POLICY, SESSION_COOKIE } from "./auth.js";

/** Minimal Cookie header parser — avoids a dependency for one header. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key || key in out) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0:0:0:0:0:0:0:1"]);

const hostnameOf = (hostHeader) => {
  const value = String(hostHeader || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1); // bracketed IPv6
  return value.split(":")[0];
};

export const isLoopbackHost = (hostHeader) => LOOPBACK_HOSTS.has(hostnameOf(hostHeader));

export function isLoopbackAddress(addr) {
  if (!addr) return false;
  const clean = String(addr).replace(/^::ffff:/, "");
  return clean === "127.0.0.1" || clean === "::1" || clean.startsWith("127.");
}

/**
 * Same-origin check for state-changing requests (CSRF defense, belt to the
 * SameSite=Strict cookie's braces). A browser always sends Origin on
 * cross-origin requests; when it is absent we fall back to Referer, and when
 * both are absent we allow — that is a non-browser caller such as curl, which
 * has no ambient cookie to be abused in the first place.
 */
export function originAllowed(req) {
  const origin = req.headers.origin;
  const source = origin || req.headers.referer;
  if (!source) return true;
  let host;
  try {
    host = new URL(source).host;
  } catch {
    return false;
  }
  if (host.toLowerCase() === String(req.headers.host || "").toLowerCase()) return true;
  // The dev frontend is Vite on another loopback port proxying /api; treat any
  // loopback origin as same-site for local operation only.
  return isLoopbackHost(host);
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function installAuth(app, auth, options = {}) {
  const secureCookies = options.secureCookies ?? false;

  app.use((req, _res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    req.sessionToken = req.cookies[SESSION_COOKIE] || null;
    next();
  });

  // Local-only operation. A request that did not arrive over loopback, or that
  // claims a non-loopback Host, is refused outright: this build is not
  // authorized for remote exposure and must not half-work if it is proxied.
  app.use((req, res, next) => {
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isLoopbackHost(req.headers.host)) {
      return res.status(403).json({ error: "local access only" });
    }
    next();
  });

  // Nothing the API returns may sit in a shared or back-button cache: a logged
  // out browser must not be able to re-render business data from a cached 200.
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Vary", "Cookie");
    next();
  });

  app.use((req, res, next) => {
    if (MUTATING.has(req.method) && !originAllowed(req)) {
      return res.status(403).json({ error: "cross-origin request rejected" });
    }
    next();
  });

  const setSessionCookie = (res, token) => {
    const parts = [
      `${SESSION_COOKIE}=${token}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${Math.floor(POLICY.absoluteMs / 1000)}`,
    ];
    if (secureCookies) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  };

  const clearSessionCookie = (res) => {
    const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
    if (secureCookies) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  };

  // An unreadable auth store means we cannot prove anyone is allowed in, so
  // nobody is. 503 — never 200 with setupRequired, which would invite an
  // attacker to re-bootstrap a damaged installation.
  const unavailable = (res) => res.status(503).json({ error: "authentication unavailable" });

  app.get("/api/auth/status", (req, res) => {
    try {
      res.json(auth.status(req.sessionToken));
    } catch (err) {
      if (err instanceof AuthStoreUnavailable) return unavailable(res);
      throw err;
    }
  });

  app.post("/api/auth/setup", (req, res) => {
    const { password, confirm_password: confirm } = req.body || {};
    try {
      const result = auth.createAdmin(password, confirm);
      if (!result.ok) {
        // "exists" is a 409 on a closed bootstrap, not a hint about credentials.
        const code = result.reason === "exists" ? 409 : 400;
        return res.status(code).json({ error: result.message || "setup rejected" });
      }
      // Setup does not log the operator in; they sign in with what they just
      // chose, which proves the stored hash actually verifies.
      res.json({ ok: true, username: result.username });
    } catch (err) {
      if (err instanceof AuthStoreUnavailable) return unavailable(res);
      throw err;
    }
  });

  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body || {};
    try {
      const result = auth.login({ username, password, currentToken: req.sessionToken });
      if (!result.ok) {
        if (result.reason === "throttled") {
          res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
          return res.status(429).json({
            error: "Too many attempts. Try again later.",
            retry_after_seconds: Math.ceil(result.retryAfterMs / 1000),
          });
        }
        // One generic message for every failure mode: wrong password, wrong
        // username, no admin at all. The client cannot tell them apart.
        return res.status(401).json({ error: "Incorrect username or password." });
      }
      setSessionCookie(res, result.token);
      res.json({ ok: true, username: result.username, role: result.role });
    } catch (err) {
      if (err instanceof AuthStoreUnavailable) return unavailable(res);
      throw err;
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    try {
      auth.destroySession(req.sessionToken);
    } catch (err) {
      if (err instanceof AuthStoreUnavailable) {
        // Do not claim the server session was invalidated when it was not. The
        // cookie still goes, so this browser loses its handle either way.
        clearSessionCookie(res);
        return res.status(503).json({ error: "logout failed: authentication unavailable" });
      }
      throw err;
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  function requireAdmin(req, res, next) {
    let session;
    try {
      session = auth.resolveSession(req.sessionToken);
    } catch (err) {
      if (err instanceof AuthStoreUnavailable) return unavailable(res);
      throw err;
    }
    if (!session.valid) {
      if (req.sessionToken) clearSessionCookie(res);
      return res.status(401).json({
        error: "authentication required",
        // Enough for the UI to say "your session expired" instead of "wrong
        // password"; no business or account detail.
        reason: session.reason === "idle" || session.reason === "absolute" ? "expired" : "unauthenticated",
      });
    }
    // Role comes from the trusted session record. Anything the client sent —
    // body field, header, cookie — is ignored by construction.
    if (session.role !== "admin") {
      return res.status(403).json({ error: "administrator access required" });
    }
    req.auth = { username: session.username, role: session.role };
    next();
  }

  return { requireAdmin, setSessionCookie, clearSessionCookie };
}
