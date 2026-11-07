// POST /api/places/search — the only server-side surface in GapVera.
//
// A Cloudflare Pages Function. It exists for exactly one reason: the Google
// Maps Platform API key must never reach the browser. A key in the client
// bundle is a key anyone can lift from the shipped JavaScript and spend
// against Erik's project, so the request is made here, at the edge, where the
// key lives as an encrypted Pages secret and is read from `context.env` at
// runtime only.
//
// Order of operations, and why it is this order:
//
//   1. Method/content-type check   — cheap, no credentials consulted.
//   2. Key presence                — refuse before authenticating if there is
//                                    nothing to authenticate FOR.
//   3. Owner authentication        — the caller's own Supabase token, verified
//                                    server-side against GoTrue + app_owner.
//   4. Input validation            — strict allowlist. A rejected input must
//                                    not consume a ledger slot or a cent.
//   5. Ledger claim (cap check)    — recorded BEFORE spending, so a crash
//                                    cannot spend silently.
//   6. The single Google request   — one billable Text Search Pro event.
//   7. Shape + attribution         — no coordinates, no derived content,
//                                    no-store, nothing persisted.
//
// Every failure path refuses. There is no branch that falls through to
// "search anyway".

import {
  FIELD_MASK,
  PAGE_SIZE,
  PLACES_ENDPOINT,
  InvalidInput,
  classifyGoogleFailure,
  parseLookupRequest,
  shapeLookupResponse,
} from '../../_lib/places.js';
import { RequestRefused, closeSlot, requireOwner, reserveLookup } from '../../_lib/owner.js';

/** Env var names holding the Google key, in precedence order. */
const KEY_ENV_VARS = ['GOOGLE_MAPS_API_KEY', 'GOOGLE_PLACES_API_KEY'];

function googleKey(env) {
  for (const name of KEY_ENV_VARS) {
    const value = (env?.[name] || '').trim();
    if (value) return value;
  }
  return '';
}

// no-store on every response: Places content may not be cached (Google Maps
// Platform ToS 3.2.3(b)), and that applies to Cloudflare's cache and the
// browser's as much as to a database. Vary: Authorization so a cache that
// ignores no-store still cannot serve one account's response to another.
const BASE_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'X-Content-Type-Options': 'nosniff',
  Vary: 'Authorization',
});

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

function refusal(status, message, reason, extra = {}) {
  return json({ error: message, reason, ...extra }, status);
}

export async function onRequest(context) {
  const { request, env } = context;

  // ---- 1. Method ----------------------------------------------------------
  // POST only. A GET that spends money is a link someone can be tricked into
  // loading, and it would put the query in logs.
  if (request.method === 'OPTIONS') {
    // Same-origin only; no CORS allowance is granted. Answering OPTIONS
    // without Access-Control-Allow-Origin is what refuses a cross-site caller.
    return new Response(null, { status: 204, headers: { Allow: 'POST', ...BASE_HEADERS } });
  }
  if (request.method !== 'POST') {
    return refusal(405, 'Use POST to run a lookup.', 'method_not_allowed');
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    // Also a CSRF guard: a cross-site HTML form cannot send application/json,
    // so requiring it means a forged form submission is rejected here.
    return refusal(415, 'Send a JSON body.', 'unsupported_media_type');
  }

  let ctx;
  let reservation = null;
  try {
    // ---- 2. Owner authentication ------------------------------------------
    // BEFORE the key-presence check: deployment configuration is not a fact an
    // anonymous caller is entitled to. Doing this in the other order let an
    // unauthenticated request distinguish "no key here" from "key present",
    // which is a small infrastructure leak and was caught in live testing.
    ctx = await requireOwner(request, env);

    // ---- 3. Key presence --------------------------------------------------
    // Fail closed and say so plainly. The old local adapter returned generated
    // mock results when the key was absent; that is exactly the "fake success"
    // the acceptance criteria forbid, so it is not reproduced here.
    const key = googleKey(env);
    if (!key) {
      return refusal(
        503,
        'Google lookup is not configured for this deployment, so no search was performed.',
        'google_key_missing'
      );
    }

    // ---- 4. Input validation ---------------------------------------------
    let body;
    try {
      body = await request.json();
    } catch {
      throw new InvalidInput('Could not read the request body as JSON.');
    }
    const query = parseLookupRequest(body);

    // ---- 5. Ledger claim + cap check -------------------------------------
    reservation = await reserveLookup(ctx, query);

    // ---- 6. The one billable request -------------------------------------
    let googleRes;
    try {
      googleRes = await fetch(PLACES_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: query.textQuery,
          pageSize: PAGE_SIZE,
          languageCode: 'en',
        }),
      });
    } catch {
      await closeSlot(ctx, reservation.slot, { status: 'failed', detail: { reason: 'google_unreachable' } });
      return refusal(
        503,
        'GapVera could not reach Google Places. No results were returned.',
        'google_unreachable',
        { usage: reservation.usage }
      );
    }

    let googleBody = {};
    try {
      googleBody = await googleRes.json();
    } catch {
      /* fall through to the !ok / empty-results handling below */
    }

    if (!googleRes.ok) {
      const mapped = classifyGoogleFailure(googleRes.status, googleBody?.error?.status);
      await closeSlot(ctx, reservation.slot, {
        status: 'failed',
        // Google's own message can echo the request and name the project, so
        // only the structured status is recorded, never the message body.
        detail: { reason: 'google_error', http_status: googleRes.status, google_status: googleBody?.error?.status || null },
      });
      return refusal(mapped.status, mapped.message, 'google_error', { usage: reservation.usage });
    }

    // ---- 7. Shape, attribute, return -------------------------------------
    const payload = shapeLookupResponse(googleBody, query, reservation.usage);
    await closeSlot(ctx, reservation.slot, {
      // Result COUNT only. Storing the names/addresses here would be caching
      // Places content in the database, which is the thing this whole design
      // exists to avoid.
      status: 'done',
      detail: { reason: 'ok', result_count: payload.count },
    });
    return json(payload, 200);
  } catch (err) {
    if (err instanceof InvalidInput) {
      // Rejected before the ledger claim, so nothing was spent or counted.
      return refusal(400, err.message, 'invalid_input');
    }
    if (err instanceof RequestRefused) {
      return refusal(err.status, err.message, err.reason);
    }
    // Unexpected. Say nothing about internals, and release the ledger slot's
    // outcome if one was claimed so the row does not sit `running` forever.
    if (ctx && reservation) {
      await closeSlot(ctx, reservation.slot, { status: 'failed', detail: { reason: 'unexpected_error' } });
    }
    return refusal(500, 'The lookup failed unexpectedly. Nothing was saved.', 'unexpected_error');
  }
}
