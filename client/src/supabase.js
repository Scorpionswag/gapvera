// Dependency-free Supabase client: GoTrue (auth) + PostgREST (data) + Storage.
//
// Why hand-written instead of @supabase/supabase-js: the build environment for
// this migration cannot install new npm packages, and the three REST surfaces
// we actually use are small and stable. This file is the entire client.
//
// Security contract (acceptance 3, 7, 8):
//   * Only the anon/publishable key is ever present here. It is a public
//     identifier, not a secret — RLS in Postgres is what protects the data.
//     The service_role key must never reach this file or the bundle.
//   * Every data call sends the user's access token. With no token, PostgREST
//     sees `anon`, whose grants were revoked in 0001_schema.sql, so an
//     unauthenticated request fails closed at the privilege layer.
//   * A 401 from any call clears the stored session and notifies the app, so a
//     revoked or expired token cannot leave a half-live UI on screen.

// Vite inlines import.meta.env at build time. The fallbacks keep this module
// importable outside a bundler — `node --test` imports it, and import.meta.env
// does not exist there — without the production path depending on either one.
const ENV =
  (typeof import.meta !== "undefined" && import.meta.env) ||
  (typeof globalThis !== "undefined" && globalThis.__TEST_ENV__) ||
  {};

const URL_BASE = (ENV.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const ANON_KEY = ENV.VITE_SUPABASE_ANON_KEY || "";

// Deployment misconfiguration must be loud and must not look like a login
// failure. App.jsx renders a dedicated screen when this is false.
export const isConfigured = Boolean(URL_BASE && ANON_KEY);

export const AUTH_LOST_EVENT = "gapvera:auth-lost";

const STORAGE_KEY = "gapvera.session";
const DOCUMENTS_BUCKET = "documents";

// Refresh this far before actual expiry so a request in flight doesn't race
// the token's death.
const REFRESH_SKEW_SECONDS = 60;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.access_token || !s?.refresh_token) return null;
    return s;
  } catch {
    // Corrupt or unreadable storage is treated as "no session" rather than
    // throwing on every call forever.
    return null;
  }
}

function writeSession(session) {
  const stored = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    // GoTrue returns expires_in (seconds from now); expires_at may be absent.
    expires_at: session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600),
    user: session.user ? { id: session.user.id, email: session.user.email } : null,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private-mode storage refusal must not break the login itself; the
    // session simply won't survive a reload.
  }
  return stored;
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

// Tell the app shell the session is gone so it tears the workspace down.
// Called on logout, on refresh failure, and on any 401 from a data call.
function announceAuthLost(reason) {
  clearSession();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, { detail: { reason } }));
  }
}

// ---------------------------------------------------------------------------
// Token acquisition
// ---------------------------------------------------------------------------

// Single in-flight refresh. Without this, a page that fires six parallel
// queries on mount would start six refreshes; GoTrue rotates the refresh token
// on use, so five of them would present an already-consumed token and the
// session would be destroyed by its own success.
let refreshInFlight = null;

async function refreshSession(session) {
  const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!res.ok) {
    announceAuthLost("expired");
    throw new ApiError("Your session expired.", 401);
  }
  return writeSession(await res.json());
}

// Returns a usable access token, refreshing first if it is at or near expiry.
// Returns null when there is no session at all.
async function accessToken() {
  const session = readSession();
  if (!session) return null;

  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at - REFRESH_SKEW_SECONDS > now) return session.access_token;

  if (!refreshInFlight) {
    refreshInFlight = refreshSession(session).finally(() => {
      refreshInFlight = null;
    });
  }
  const fresh = await refreshInFlight;
  return fresh.access_token;
}

export function currentUser() {
  return readSession()?.user || null;
}

export function hasSession() {
  return Boolean(readSession());
}

// ---------------------------------------------------------------------------
// Authenticated request core
// ---------------------------------------------------------------------------

async function authedFetch(path, { method = "GET", headers = {}, body, raw = false } = {}) {
  if (!isConfigured) throw new ApiError("Supabase is not configured for this build.", 0);

  const token = await accessToken();
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      // No token means no Authorization header, so PostgREST applies the anon
      // role, which has no grants. The request fails closed server-side.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });

  if (res.status === 401 || res.status === 403) {
    // 403 from PostgREST here means the role lost its grants (token revoked,
    // or never owner). Either way the UI must stop pretending it has access.
    announceAuthLost(res.status === 401 ? "expired" : "forbidden");
    throw new ApiError(res.status === 401 ? "Your session expired." : "Access denied.", res.status);
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      detail = err.message || err.error_description || err.error || err.hint || detail;
    } catch {
      /* non-JSON error body; keep the status line */
    }
    throw new ApiError(detail, res.status);
  }

  if (raw) return res;
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const supaAuth = {
  // Public signup is disabled in the dashboard (acceptance 3) and there is no
  // signUp call anywhere in this client, so the app offers no path to create
  // an account even if that toggle were flipped.
  async signIn(email, password) {
    if (!isConfigured) throw new ApiError("Supabase is not configured for this build.", 0);
    const res = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(
        data.error_description || data.msg || data.message || "Sign in failed.",
        res.status
      );
    }
    writeSession(data);
    return data;
  },

  async signOut() {
    const session = readSession();
    // Clear locally first and unconditionally. If the network call fails, the
    // browser must still end up signed out rather than keeping a live token
    // because the server was unreachable.
    clearSession();
    if (!session || !isConfigured) return;
    try {
      await fetch(`${URL_BASE}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.access_token}` },
      });
    } catch {
      // Token is already discarded client-side; it expires server-side on its
      // own. Surfacing this as a logout failure would be misleading.
    }
  },

  // Confirms with the server that the stored token is actually still valid,
  // and that the account is the owner. Used by the app shell on load so a
  // stale localStorage entry cannot grant a logged-in-looking UI.
  async verify() {
    if (!readSession()) return { authenticated: false };
    try {
      const user = await authedFetch("/auth/v1/user");
      // The owner check is a real query against an RLS-protected table: it
      // returns a row only when app_owner contains this uid. A signed-in
      // non-owner is authenticated but has access to nothing.
      const owner = await authedFetch(`/rest/v1/app_owner?select=user_id&user_id=eq.${user.id}`);
      return {
        authenticated: true,
        isOwner: Array.isArray(owner) && owner.length > 0,
        user: { id: user.id, email: user.email },
      };
    } catch (err) {
      if (err.status === 401 || err.status === 403) return { authenticated: false };
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// PostgREST data access
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };
// return=representation makes writes echo the stored row, so the UI shows what
// the database actually holds (defaults applied, triggers run) instead of the
// object it hoped it wrote.
const RETURN_ROW = { ...JSON_HEADERS, Prefer: "return=representation" };

export const db = {
  select(table, query = "") {
    const q = query ? `&${query}` : "";
    return authedFetch(`/rest/v1/${table}?select=*${q}`);
  },

  async insert(table, payload) {
    const rows = await authedFetch(`/rest/v1/${table}`, {
      method: "POST",
      headers: RETURN_ROW,
      body: JSON.stringify(payload),
    });
    return Array.isArray(payload) ? rows : rows?.[0];
  },

  async update(table, id, payload) {
    const rows = await authedFetch(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: RETURN_ROW,
      body: JSON.stringify(payload),
    });
    return rows?.[0];
  },

  async remove(table, id) {
    await authedFetch(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  },

  // Raw escape hatch for the few queries that need custom filters/embeds.
  raw: (path, options) => authedFetch(`/rest/v1${path}`, options),
};

// ---------------------------------------------------------------------------
// Storage (private bucket, signed access only — acceptance 6)
// ---------------------------------------------------------------------------

export const storage = {
  async upload(objectPath, file) {
    return authedFetch(`/storage/v1/object/${DOCUMENTS_BUCKET}/${objectPath}`, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        // Never silently overwrite an existing object; stored names are random
        // so a collision means something is wrong and should surface.
        "x-upsert": "false",
      },
      body: file,
    });
  },

  // The bucket is private: there is no public URL for a document. Access is
  // always a short-lived signed URL minted for an authenticated owner.
  async signedUrl(objectPath, { expiresIn = 60, download = false } = {}) {
    const res = await authedFetch(`/storage/v1/object/sign/${DOCUMENTS_BUCKET}/${objectPath}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ expiresIn }),
    });
    const signed = res?.signedURL || res?.signedUrl;
    if (!signed) throw new ApiError("Storage did not return a signed URL.", 0);
    const url = `${URL_BASE}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}`;
    return download ? `${url}${url.includes("?") ? "&" : "?"}download=` : url;
  },

  async remove(objectPath) {
    await authedFetch(`/storage/v1/object/${DOCUMENTS_BUCKET}/${objectPath}`, { method: "DELETE" });
    return { ok: true };
  },
};

export { ApiError };
