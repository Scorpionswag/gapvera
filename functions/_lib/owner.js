// Owner-only authentication and the usage ledger, for the Places lookup proxy.
//
// Split from the handler so the policy is testable with injected fetches, and
// split from places.js so the compliance/cost rules stay readable on their own.
//
// ---------------------------------------------------------------------------
// Why no service_role key
// ---------------------------------------------------------------------------
// This proxy authenticates by forwarding the CALLER's own Supabase access
// token to Supabase and asking Supabase who they are. It never holds a
// service_role key, so there is no credential here that could bypass RLS even
// if the Function were compromised. Ownership is decided by the same
// RLS-protected `app_owner` read the browser does, and ledger rows are written
// as the owner, under `job_runs`'s owner-only policy.
//
// The honest limitation of that choice: the ledger is owned by Erik, so Erik
// could delete rows and reset his own cap. The cap exists to stop an accident
// or a runaway loop from reaching billable usage, not to restrain the account
// holder from spending his own money deliberately. Holding a service_role key
// at the edge to make the cap tamper-proof against its own owner would be a
// far worse trade.

import { LEDGER_JOB, LIMITS, BILLABLE_SKU, checkAllowance, dayKey, monthKey, ledgerKey } from './places.js';

/** Thrown for anything that must become a 4xx with a safe message. */
export class RequestRefused extends Error {
  constructor(status, message, reason) {
    super(message);
    this.name = 'RequestRefused';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Read the Supabase connection details from the Pages environment.
 *
 * Pages exposes project environment variables to Functions at runtime on
 * `context.env`, so the two `VITE_`-prefixed values the client build already
 * uses are available here without duplicating configuration. The `SUPABASE_`
 * names are accepted first so the Function can be pointed elsewhere without
 * touching the client build.
 *
 * Both are non-secret by design: the publishable key is already in the
 * shipped bundle, and RLS — not its secrecy — is what protects the data.
 */
export function supabaseConfig(env) {
  const url = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '';
  return { url, key, configured: Boolean(url && key) };
}

/**
 * Pull the bearer token off the request.
 *
 * Deliberately strict: no cookie fallback and no query parameter. A token in a
 * URL ends up in logs and in `Referer` headers, and a cookie-authenticated
 * POST that spends money is a CSRF target. An `Authorization` header cannot be
 * attached by a cross-site form.
 */
export function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Verify the caller is the signed-in GapVera owner.
 *
 * Two questions asked of Supabase, in order, with the caller's own token:
 *   1. GoTrue: is this token live? (A locally-decoded JWT would still look
 *      valid after a logout; asking the server does not.)
 *   2. PostgREST: does `app_owner` contain this uid? This read is itself
 *      RLS-gated, so a non-owner gets an empty array rather than a row.
 *
 * Fails closed on every ambiguity — an unreachable Supabase, an unprovisioned
 * schema, or a malformed answer all deny. Nothing is spent on a caller whose
 * identity could not be established.
 */
export async function requireOwner(request, env, fetchImpl = fetch) {
  const { url, key, configured } = supabaseConfig(env);
  if (!configured) {
    throw new RequestRefused(
      503,
      'GapVera is not connected to its backend, so it cannot verify who is asking. No lookup was performed.',
      'supabase_unconfigured'
    );
  }

  const token = bearerToken(request);
  if (!token) {
    throw new RequestRefused(401, 'Sign in to GapVera to use the Google lookup.', 'no_token');
  }

  const authHeaders = { apikey: key, Authorization: `Bearer ${token}` };

  let userRes;
  try {
    userRes = await fetchImpl(`${url}/auth/v1/user`, { headers: authHeaders });
  } catch {
    throw new RequestRefused(
      503,
      'GapVera could not reach Supabase to verify your session, so the lookup was not sent.',
      'supabase_unreachable'
    );
  }
  if (userRes.status === 401 || userRes.status === 403) {
    throw new RequestRefused(401, 'Your session is no longer valid. Sign in again.', 'token_rejected');
  }
  if (!userRes.ok) {
    throw new RequestRefused(
      503,
      'GapVera could not verify your session, so the lookup was not sent.',
      'verify_failed'
    );
  }

  let user;
  try {
    user = await userRes.json();
  } catch {
    throw new RequestRefused(503, 'GapVera could not read the session response.', 'verify_unreadable');
  }
  if (!user?.id) {
    throw new RequestRefused(401, 'Your session is no longer valid. Sign in again.', 'no_user_id');
  }

  // Ownership. An error here must never read as "allowed".
  let ownerRes;
  try {
    ownerRes = await fetchImpl(
      `${url}/rest/v1/app_owner?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`,
      { headers: authHeaders }
    );
  } catch {
    throw new RequestRefused(
      503,
      'GapVera could not confirm your access, so the lookup was not sent.',
      'owner_check_unreachable'
    );
  }
  if (!ownerRes.ok) {
    // Includes an unprovisioned database (404) and a revoked grant (401/403).
    // Ownership is undecidable, so it is denied. The message names no table.
    throw new RequestRefused(
      403,
      'GapVera could not confirm that this account owns the workspace, so the lookup was not sent.',
      'owner_check_failed'
    );
  }

  let rows;
  try {
    rows = await ownerRes.json();
  } catch {
    throw new RequestRefused(403, 'GapVera could not confirm your access.', 'owner_check_unreadable');
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RequestRefused(403, 'This account is not authorized to use GapVera.', 'not_owner');
  }

  return { userId: user.id, token, supabase: { url, key }, authHeaders };
}

// ---------------------------------------------------------------------------
// Usage ledger (public.job_runs)
// ---------------------------------------------------------------------------
//
// Reuses the existing durable job ledger rather than adding a table, so the
// unique index on (job, idempotency_key) and the owner-only RLS policy already
// built and tested for it apply here unchanged.

/**
 * Count lookups already recorded today and this month.
 *
 * `Prefer: count=exact` with `head=true` makes PostgREST return the count in
 * `Content-Range` without a body, so this is two cheap requests regardless of
 * how many rows exist.
 *
 * Returns `null` on any failure. The caller must treat that as "unknown", and
 * `checkAllowance` refuses on unknown — an unreadable ledger must never read
 * as an unused allowance.
 */
export async function readUsage(ctx, fetchImpl = fetch, now = new Date()) {
  const base = `${ctx.supabase.url}/rest/v1/${encodeURIComponent('job_runs')}`;
  const headers = { ...ctx.authHeaders, Prefer: 'count=exact' };

  const countFor = async (prefix) => {
    const query =
      `?select=id&job=eq.${LEDGER_JOB}` +
      `&idempotency_key=like.${encodeURIComponent(`${prefix}%`)}`;
    let res;
    try {
      res = await fetchImpl(`${base}${query}`, { method: 'HEAD', headers });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    // Content-Range: "0-24/25" or "*/0" when empty.
    const range = res.headers.get('Content-Range') || '';
    const total = range.split('/')[1];
    if (total === undefined) return null;
    const n = Number.parseInt(total, 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  const [usedToday, usedThisMonth] = await Promise.all([countFor(dayKey(now)), countFor(monthKey(now))]);
  if (usedToday === null || usedThisMonth === null) return null;
  return { usedToday, usedThisMonth };
}

/**
 * Claim a ledger slot BEFORE spending a billable request.
 *
 * Ordering is the whole point: a row written after a successful call would not
 * count a call that was made and then failed to record, so a crashing loop
 * could spend without ever incrementing. Claiming first means the worst case
 * is an over-count (a slot consumed by a lookup that failed), which costs
 * nothing but a slot. The unique index on (job, idempotency_key) makes a
 * retried claim with the same key a conflict rather than a second charge.
 */
export async function claimSlot(ctx, { niche, city }, fetchImpl = fetch, now = new Date(), uuid = crypto.randomUUID()) {
  const key = ledgerKey(uuid, now);
  const res = await fetchImpl(`${ctx.supabase.url}/rest/v1/job_runs`, {
    method: 'POST',
    headers: { ...ctx.authHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      job: LEDGER_JOB,
      idempotency_key: key,
      status: 'running',
      // The query is recorded so usage is auditable and a surprising bill can
      // be traced to the searches that caused it. No Places CONTENT is stored
      // here — only GapVera's own input, which is Erik's text, not Google's.
      detail: { niche, city, sku: BILLABLE_SKU, billable_events: 1 },
    }),
  });
  if (!res.ok) {
    throw new RequestRefused(
      503,
      'GapVera could not record this lookup in its usage ledger, so it was not sent. Nothing was charged.',
      'ledger_write_failed'
    );
  }
  let rows = null;
  try {
    rows = await res.json();
  } catch {
    /* representation is a convenience; the claim itself succeeded */
  }
  return { key, id: Array.isArray(rows) ? rows[0]?.id ?? null : null };
}

/**
 * Close a claimed slot. Best-effort by design: the claim already counted the
 * spend, so a failure to write the outcome must not fail the request the
 * operator already paid for. The row stays `running`, which still counts.
 */
export async function closeSlot(ctx, slot, outcome, fetchImpl = fetch) {
  if (!slot?.key) return false;
  try {
    const res = await fetchImpl(
      `${ctx.supabase.url}/rest/v1/job_runs` +
        `?job=eq.${LEDGER_JOB}&idempotency_key=eq.${encodeURIComponent(slot.key)}`,
      {
        method: 'PATCH',
        headers: { ...ctx.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: outcome.status,
          finished_at: new Date().toISOString(),
          detail: { ...(outcome.detail || {}), sku: BILLABLE_SKU, billable_events: 1 },
        }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Read the ledger, apply the caps, and claim a slot — the whole guardrail in
 * one call so the handler cannot accidentally do them out of order.
 */
export async function reserveLookup(ctx, query, fetchImpl = fetch, now = new Date()) {
  const usage = await readUsage(ctx, fetchImpl, now);
  // null (unreadable) is passed through deliberately: checkAllowance refuses on
  // anything that is not a pair of non-negative integers.
  const verdict = checkAllowance(usage || { usedToday: -1, usedThisMonth: -1 });
  if (!verdict.allowed) {
    throw new RequestRefused(429, verdict.message, verdict.reason);
  }
  const slot = await claimSlot(ctx, query, fetchImpl, now);
  return {
    slot,
    usage: {
      usedToday: usage.usedToday + 1,
      usedThisMonth: usage.usedThisMonth + 1,
      remainingToday: verdict.remainingToday,
      remainingThisMonth: verdict.remainingThisMonth,
      dailyCap: LIMITS.perDay,
      monthlyCap: LIMITS.perMonth,
      freeTierPerMonth: LIMITS.freeTierPerMonth,
      sku: BILLABLE_SKU,
      billableEvents: 1,
    },
  };
}
