// Integration test of the REAL Pages Function handler, before deployment.
//
// Why this exists separately from functions/places.test.mjs: that file tests
// the pure logic with injected fetches. This one imports the actual
// `onRequest` handler that Cloudflare will execute, drives it with real
// Request objects, and asserts on real Response objects — so the wiring
// between the pieces (method gating, header requirements, env lookup, error
// mapping, response headers) is exercised as shipped, not as designed.
//
// Supabase is stubbed, because the point is the handler. Google is stubbed by
// default and optionally REAL: with --live it performs one genuine billable
// Places request using the local key, which is the only way to know the field
// mask, endpoint, and response parsing agree with the live API before Erik's
// first click in production.
//
// Run:  node migration/test-harness/function-integration.mjs
//       node migration/test-harness/function-integration.mjs --live
//
// The key is read into memory from server/.env and never printed.

import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const live = process.argv.includes('--live');

const { onRequest: search } = await import('../../functions/api/places/search.js');
const { onRequest: usage } = await import('../../functions/api/places/usage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let realKey = '';
const envPath = `${process.env.HOME}/gapvera/server/.env`;
if (existsSync(envPath)) {
  const m = readFileSync(envPath, 'utf8').match(/^GOOGLE_MAPS_API_KEY=(.*)$/m);
  realKey = (m?.[1] || '').trim().replace(/^["']|["']$/g, '');
}

const ENV = {
  GOOGLE_MAPS_API_KEY: realKey || 'test-key-not-real',
  VITE_SUPABASE_URL: 'https://project.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_test',
};

const OWNER_ID = 'uuid-erik';

/** Ledger state the Supabase stub answers from. */
let ledger = { today: 0, month: 0, writable: true, readable: true };
/** Every request the handler made, for post-hoc assertions. */
let outbound = [];

const realFetch = globalThis.fetch;

function installStubFetch({ owner = true, googleStatus = 200, googleBody = null, googleThrows = false } = {}) {
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    outbound.push({ url: u, options });

    // ---- Supabase: GoTrue ----
    if (u.includes('/auth/v1/user')) {
      return new Response(JSON.stringify({ id: OWNER_ID, email: 'e@example.com' }), { status: 200 });
    }

    // ---- Supabase: ownership ----
    if (u.includes('/rest/v1/app_owner')) {
      return new Response(JSON.stringify(owner ? [{ user_id: OWNER_ID }] : []), { status: 200 });
    }

    // ---- Supabase: ledger ----
    if (u.includes('/rest/v1/job_runs')) {
      if (options.method === 'HEAD') {
        if (!ledger.readable) return new Response(null, { status: 500 });
        const isDay = /\d{4}-\d{2}-\d{2}/.test(decodeURIComponent(u));
        const total = isDay ? ledger.today : ledger.month;
        return new Response(null, { status: 200, headers: { 'Content-Range': `0-0/${total}` } });
      }
      if (options.method === 'POST') {
        if (!ledger.writable) return new Response('{}', { status: 500 });
        ledger.today += 1;
        ledger.month += 1;
        return new Response(JSON.stringify([{ id: ledger.month }]), { status: 201 });
      }
      if (options.method === 'PATCH') return new Response(null, { status: 204 });
    }

    // ---- Google Places ----
    if (u.includes('places.googleapis.com')) {
      if (live) {
        if (!realKey) throw new Error('--live requires a local GOOGLE_MAPS_API_KEY');
        return realFetch(url, options);
      }
      if (googleThrows) throw new TypeError('network down');
      const body =
        googleBody ||
        (googleStatus === 200
          ? {
              places: [
                {
                  id: 'ChIJ_stub_a',
                  displayName: { text: 'Stub Plumbing A' },
                  formattedAddress: '1 Main St, Miami, FL',
                  nationalPhoneNumber: '(305) 555-0101',
                  rating: 4.4,
                  userRatingCount: 31,
                  googleMapsUri: 'https://maps.google.com/?cid=1',
                },
                {
                  id: 'ChIJ_stub_b',
                  displayName: { text: 'Stub Plumbing B' },
                  formattedAddress: '2 Main St, Miami, FL',
                  websiteUri: 'https://b.example',
                  googleMapsUri: 'https://maps.google.com/?cid=2',
                },
              ],
            }
          : { error: { status: 'PERMISSION_DENIED', code: googleStatus, message: `key AIza-SECRET denied for project 12345` } });
      return new Response(JSON.stringify(body), { status: googleStatus });
    }

    throw new Error(`unexpected fetch: ${u}`);
  };
}

const post = (body, headers = { Authorization: 'Bearer caller-token', 'Content-Type': 'application/json' }) =>
  new Request('https://gapvera.example/api/places/search', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const reset = () => {
  ledger = { today: 0, month: 0, writable: true, readable: true };
  outbound = [];
};

let passed = 0;
let failed = 0;
let skipped = 0;
async function check(name, fn, { stubOnly = false } = {}) {
  if (stubOnly && live) {
    // A failure-injection case cannot be injected when Google is real. Skipping
    // it loudly is honest; silently reporting it as passed would not be.
    console.log(`  skip ${name} (needs a stubbed Google)`);
    skipped++;
    return;
  }
  reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

console.log(`\nhandler integration (${live ? 'LIVE Google — one billable request will be spent' : 'stubbed Google'})\n`);

await check('GET is rejected without touching Supabase or Google', async () => {
  installStubFetch();
  const res = await search({ request: new Request('https://g.example/api/places/search'), env: ENV });
  assert.equal(res.status, 405);
  assert.equal(outbound.length, 0, 'nothing should have been contacted');
});

await check('a form-encoded POST is rejected (CSRF guard)', async () => {
  installStubFetch();
  const res = await search({
    request: post('niche=plumber&city=Miami', {
      Authorization: 'Bearer caller-token',
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    env: ENV,
  });
  assert.equal(res.status, 415);
  assert.equal(outbound.length, 0);
});

await check('a missing Google key fails closed with no mock results', async () => {
  installStubFetch();
  const res = await search({
    request: post({ niche: 'plumber', city: 'Miami' }),
    env: { ...ENV, GOOGLE_MAPS_API_KEY: '' },
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.reason, 'google_key_missing');
  // The old local adapter returned generated mock businesses here. That is the
  // "fake success" the acceptance criteria forbid; assert it is really gone.
  assert.ok(!('results' in body), 'a key-less deployment must not return results');
  assert.equal(outbound.length, 0);
});

await check('an anonymous caller is refused before anything is spent', async () => {
  installStubFetch();
  const res = await search({
    request: post({ niche: 'plumber', city: 'Miami' }, { 'Content-Type': 'application/json' }),
    env: ENV,
  });
  assert.equal(res.status, 401);
  assert.equal(ledger.today, 0, 'no ledger slot may be consumed');
  assert.ok(!outbound.some((c) => c.url.includes('googleapis')), 'Google must not be called');
});

await check('a signed-in non-owner is refused and spends nothing', async () => {
  installStubFetch({ owner: false });
  const res = await search({ request: post({ niche: 'plumber', city: 'Miami' }), env: ENV });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).reason, 'not_owner');
  assert.equal(ledger.today, 0);
  assert.ok(!outbound.some((c) => c.url.includes('googleapis')));
});

await check('invalid input is refused without consuming a ledger slot', async () => {
  installStubFetch();
  const res = await search({ request: post({ niche: 'x'.repeat(200), city: 'Miami' }), env: ENV });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'invalid_input');
  assert.equal(ledger.today, 0, 'a rejected input must cost nothing');
  assert.ok(!outbound.some((c) => c.url.includes('googleapis')));
});

await check('an unreadable ledger pauses lookups instead of allowing them', async () => {
  installStubFetch();
  ledger.readable = false;
  const res = await search({ request: post({ niche: 'plumber', city: 'Miami' }), env: ENV });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).reason, 'ledger_unreadable');
  assert.ok(!outbound.some((c) => c.url.includes('googleapis')), 'must not spend when the cap is unknown');
});

await check('the daily cap stops the lookup at the boundary', async () => {
  installStubFetch();
  const { LIMITS } = await import('../../functions/_lib/places.js');
  ledger.today = LIMITS.perDay;
  ledger.month = LIMITS.perDay;
  const res = await search({ request: post({ niche: 'plumber', city: 'Miami' }), env: ENV });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).reason, 'daily_cap');
  assert.ok(!outbound.some((c) => c.url.includes('googleapis')));
});

await check('a Google permission failure never leaks its message or the key', async () => {
  installStubFetch({ googleStatus: 403 });
  const res = await search({ request: post({ niche: 'plumber', city: 'Miami' }), env: ENV });
  assert.equal(res.status, 503);
  const text = JSON.stringify(await res.json());
  assert.ok(!text.includes('AIza-SECRET'), 'the key literal must not reach the client');
  assert.ok(!text.includes('PERMISSION_DENIED'), "Google's raw status must not be forwarded");
  assert.ok(!text.includes('12345'), 'the project number must not reach the client');
  if (realKey) assert.ok(!text.includes(realKey), 'the REAL key must not reach the client');
  // The slot was already claimed, so the spend is still counted.
  assert.equal(ledger.today, 1, 'a failed-after-claim lookup still counts');
}, { stubOnly: true });

await check('an unreachable Google is reported, not retried into a double charge', async () => {
  installStubFetch({ googleThrows: true });
  const res = await search({ request: post({ niche: 'plumber', city: 'Miami' }), env: ENV });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).reason, 'google_unreachable');
  assert.equal(outbound.filter((c) => c.url.includes('googleapis')).length, 1, 'exactly one attempt');
}, { stubOnly: true });

await check('a successful lookup returns shaped results with attribution', async () => {
  installStubFetch();
  const res = await search({ request: post({ niche: 'plumber', city: 'Hialeah, FL' }), env: ENV });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.clone().text()}`);

  // Response headers are part of the compliance posture, not decoration.
  assert.match(res.headers.get('Cache-Control'), /no-store/, 'Places content may not be cached');
  assert.equal(res.headers.get('Vary'), 'Authorization');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');

  const body = await res.json();
  assert.ok(body.count >= 1, `expected results, got ${body.count}`);
  assert.equal(body.attribution.poweredByGoogle, true);
  assert.equal(body.persistence.savesToCrm, false);
  assert.deepEqual(body.persistence.storableFields, ['place_id']);

  // No coordinates anywhere in the payload — the Territory map is OSM.
  const text = JSON.stringify(body);
  assert.ok(!/"lat"|"lng"|"latitude"|"longitude"|"location"/.test(text), 'no coordinates may be returned');
  if (realKey) assert.ok(!text.includes(realKey), 'the key must never be in a response');

  // Exactly one billable request, exactly one ledger slot.
  assert.equal(outbound.filter((c) => c.url.includes('googleapis')).length, 1);
  assert.equal(ledger.today, 1);

  // Every result carries what the licence requires.
  for (const p of body.results) {
    assert.ok(p.place_id, 'every result needs its exempt identifier');
    assert.ok(p.business_name, 'every result needs a name');
    assert.ok(p.google_maps_uri.startsWith('https://'), 'every result links back to Google Maps');
  }

  // No-website prospects first.
  const firstWithSite = body.results.findIndex((p) => p.has_website);
  const lastWithout = body.results.map((p) => p.has_website).lastIndexOf(false);
  if (firstWithSite !== -1 && lastWithout !== -1) {
    assert.ok(lastWithout < firstWithSite, 'no-website results must sort first');
  }

  if (live) {
    console.log(`       live: ${body.count} real result(s); ${body.results.filter((p) => !p.has_website).length} with no website`);
  }
});

await check('the usage endpoint reports the allowance and spends nothing', async () => {
  installStubFetch();
  ledger.today = 3;
  ledger.month = 9;
  const res = await usage({
    request: new Request('https://g.example/api/places/usage', {
      headers: { Authorization: 'Bearer caller-token' },
    }),
    env: ENV,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.usedToday, 3);
  assert.equal(body.usedThisMonth, 9);
  assert.equal(body.billableEventsPerLookup, 1);
  assert.ok(!outbound.some((c) => c.url.includes('googleapis')), 'reading usage must not call Google');
});

await check('the usage endpoint refuses an anonymous caller', async () => {
  installStubFetch();
  const res = await usage({ request: new Request('https://g.example/api/places/usage'), env: ENV });
  assert.equal(res.status, 401);
});

await check('the usage endpoint reports an unconfigured deployment up front', async () => {
  // Found during the browser dogfood: without this, the UI showed "23 of 25
  // lookups left" and enabled the button on a deployment with no key, so the
  // only way to learn the feature was unavailable was to click it. An honest
  // error after a click is still a misleading page before one.
  installStubFetch();
  const res = await usage({
    request: new Request('https://g.example/api/places/usage', {
      headers: { Authorization: 'Bearer caller-token' },
    }),
    env: { ...ENV, GOOGLE_MAPS_API_KEY: '' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(body.configured, false);
  assert.equal(body.reason, 'google_key_missing');
  // No allowance numbers at all: there is nothing to have an allowance of.
  assert.equal(body.usedToday, undefined, 'must not report a count it cannot spend');
  assert.match(body.message, /CSV import still works/);
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
process.exit(failed ? 1 : 0);
