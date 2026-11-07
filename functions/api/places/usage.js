// GET /api/places/usage — how much of the lookup allowance is already spent.
//
// Exists so the UI can state the real cost position BEFORE Erik clicks, rather
// than only after a lookup has already been charged. It reads the ledger and
// spends nothing: no Google request is made on this path.
//
// Owner-only, same as the lookup itself. Usage is business information about
// Erik's spending and does not belong to anonymous callers.

import { BILLABLE_SKU, LIMITS, checkAllowance } from '../../_lib/places.js';
import { RequestRefused, readUsage, requireOwner } from '../../_lib/owner.js';

// Must match functions/api/places/search.js. Kept as a list rather than a
// single name so the Function can be pointed at either variable.
const KEY_ENV_VARS = ['GOOGLE_MAPS_API_KEY', 'GOOGLE_PLACES_API_KEY'];

/** Whether a key exists. Reports presence ONLY — never the value, never a prefix. */
const hasGoogleKey = (env) => KEY_ENV_VARS.some((n) => (env?.[n] || '').trim().length > 0);


const BASE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Authorization',
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: BASE_HEADERS });

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') {
    return json({ error: 'Use GET.', reason: 'method_not_allowed' }, 405);
  }

  try {
    const ctx = await requireOwner(request, env);

    // Report an unconfigured deployment BEFORE reading the ledger. Otherwise
    // the UI shows "25 lookups left" and enables a button that can only ever
    // fail — an honest error after a click is worse than no click at all.
    if (!hasGoogleKey(env)) {
      return json({
        available: false,
        reason: 'google_key_missing',
        message:
          'Google lookup is not configured for this deployment, so searches are unavailable. CSV import still works.',
        configured: false,
        dailyCap: LIMITS.perDay,
        monthlyCap: LIMITS.perMonth,
      });
    }

    const usage = await readUsage(ctx);
    if (!usage) {
      // Unreadable ledger. Report it as unknown rather than as zero used —
      // "0 of 25 used" would invite a click the lookup path will refuse.
      return json(
        {
          available: false,
          reason: 'ledger_unreadable',
          message: 'GapVera could not read its usage ledger, so lookups are paused.',
          configured: true,
          dailyCap: LIMITS.perDay,
          monthlyCap: LIMITS.perMonth,
        },
        200
      );
    }

    const verdict = checkAllowance(usage);
    return json({
      available: verdict.allowed,
      reason: verdict.allowed ? null : verdict.reason,
      message: verdict.allowed ? null : verdict.message,
      configured: true,
      usedToday: usage.usedToday,
      usedThisMonth: usage.usedThisMonth,
      dailyCap: LIMITS.perDay,
      monthlyCap: LIMITS.perMonth,
      freeTierPerMonth: LIMITS.freeTierPerMonth,
      sku: BILLABLE_SKU,
      // One lookup is one billable event, so "lookups left" and "billable
      // events left" are the same number. Said explicitly so the UI does not
      // have to assume it.
      billableEventsPerLookup: 1,
    });
  } catch (err) {
    if (err instanceof RequestRefused) {
      return json({ error: err.message, reason: err.reason }, err.status);
    }
    return json({ error: 'Could not read usage.', reason: 'unexpected_error' }, 500);
  }
}
