// Tests for the Google Places lookup proxy.
//
// Run: node --test functions/places.test.mjs
//
// The proxy is the only server-side code in GapVera and the only place that
// holds a credential which costs money when used. The cases below are
// therefore the ones that cause real harm if they regress:
//
//   * The Google API key reaching the browser, a log, or an error message.
//   * A non-owner — or an anonymous caller — spending Erik's money.
//   * The usage cap failing open when the ledger cannot be read.
//   * A request being charged without being counted.
//   * Google's Places content being persisted, exported, or handed to the
//     OpenStreetMap-based Territory map, each of which is a licence violation
//     rather than a cosmetic bug.
//
// Everything here runs against injected fetches. No network, no Cloudflare
// runtime, no real key.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BILLABLE_SKU,
  FIELD_MASK,
  InvalidInput,
  LEDGER_JOB,
  LIMITS,
  PAGE_SIZE,
  cacheablePlaceFields,
  checkAllowance,
  classifyGoogleFailure,
  dayKey,
  ledgerKey,
  monthKey,
  orderForPitch,
  parseLookupRequest,
  shapeLookupResponse,
  shapePlace,
} from "./_lib/places.js";

import {
  RequestRefused,
  bearerToken,
  claimSlot,
  readUsage,
  requireOwner,
  reserveLookup,
  supabaseConfig,
} from "./_lib/owner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV = {
  VITE_SUPABASE_URL: "https://project.supabase.co",
  VITE_SUPABASE_ANON_KEY: "sb_publishable_test",
};

const req = (headers = {}) => new Request("https://gapvera.example/api/places/search", { headers });

const ownerReq = () => req({ Authorization: "Bearer caller-token" });

/** A fetch stub that answers the GoTrue + app_owner pair as a real owner. */
function ownerFetch({ userId = "uuid-erik", ownerRows = [{ user_id: "uuid-erik" }] } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/auth/v1/user")) {
      return { ok: true, status: 200, json: async () => ({ id: userId, email: "e@example.com" }) };
    }
    if (String(url).includes("/rest/v1/app_owner")) {
      return { ok: true, status: 200, json: async () => ownerRows };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

/** Ledger HEAD responses with a given Content-Range total. */
const countRes = (total) => ({
  ok: true,
  status: 200,
  headers: { get: (h) => (h === "Content-Range" ? `0-0/${total}` : null) },
});

// ---------------------------------------------------------------------------
// The key must never be reachable from the client
// ---------------------------------------------------------------------------

test("the Places field mask never requests coordinates", () => {
  // ToS 3.2.3(e): Places content may not be shown on a non-Google map, and
  // GapVera's Territory map is OpenStreetMap. Not requesting lat/lng is what
  // makes that violation structurally impossible rather than a policy promise.
  assert.ok(!FIELD_MASK.includes("location"), "mask must not request places.location");
  assert.ok(!FIELD_MASK.includes("viewport"), "mask must not request a viewport either");
  // And it does ask for the things attribution depends on.
  assert.ok(FIELD_MASK.includes("places.id"));
  assert.ok(FIELD_MASK.includes("places.googleMapsUri"));
  assert.ok(FIELD_MASK.includes("places.attributions"));
});

test("shapePlace drops coordinates even if a future mask lets them through", () => {
  const shaped = shapePlace({
    id: "ChIJ_test",
    displayName: { text: "Acme Plumbing" },
    location: { latitude: 25.86, longitude: -80.27 },
    formattedAddress: "1 Main St",
  });
  assert.equal(shaped.business_name, "Acme Plumbing");
  // Defence in depth: the mask is the first line, this is the second.
  const serialized = JSON.stringify(shaped);
  assert.ok(!serialized.includes("25.86"), "latitude must not survive shaping");
  assert.ok(!serialized.includes("-80.27"), "longitude must not survive shaping");
  assert.ok(!("lat" in shaped) && !("lng" in shaped) && !("location" in shaped));
});

// ---------------------------------------------------------------------------
// Input validation — a rejected input must cost nothing
// ---------------------------------------------------------------------------

test("parseLookupRequest accepts a normal query and builds the text query", () => {
  const out = parseLookupRequest({ niche: "  plumber ", city: "Hialeah,  FL " });
  assert.deepEqual(out, { niche: "plumber", city: "Hialeah, FL", textQuery: "plumber in Hialeah, FL" });
});

test("parseLookupRequest collapses whitespace so one query is one ledger slot", () => {
  const a = parseLookupRequest({ niche: "pool   service", city: "Miami" });
  const b = parseLookupRequest({ niche: "pool service", city: "Miami" });
  assert.equal(a.textQuery, b.textQuery);
});

test("parseLookupRequest rejects missing, empty, oversized and unknown fields", () => {
  const bad = [
    [undefined, "non-object body"],
    [null, "null body"],
    [[], "array body"],
    [{ city: "Miami" }, "missing niche"],
    [{ niche: "plumber" }, "missing city"],
    [{ niche: "   ", city: "Miami" }, "blank niche"],
    [{ niche: "x".repeat(81), city: "Miami" }, "oversized niche"],
    [{ niche: "plumber", city: "x".repeat(81) }, "oversized city"],
    [{ niche: "plumber", city: "Miami", pageSize: 200 }, "unknown field"],
    [{ niche: 5, city: "Miami" }, "non-string niche"],
  ];
  for (const [body, label] of bad) {
    assert.throws(() => parseLookupRequest(body), InvalidInput, label);
  }
});

test("parseLookupRequest refuses injection-shaped input instead of sanitising it", () => {
  // Refusing rather than stripping matters: a silently-corrected query still
  // costs a billable event, and the operator would be paying for a search
  // they did not ask for.
  for (const niche of ['plumber"}, "pageSize": 200', "plumber\n\rX", "plumber<script>", "pl|umber", "../../etc", ".hidden"]) {
    assert.throws(() => parseLookupRequest({ niche, city: "Miami" }), InvalidInput, niche);
  }
});

test("parseLookupRequest accepts real-world punctuation in place names", () => {
  for (const [niche, city] of [
    ["bar & grill", "Coeur d'Alene, ID"],
    ["heating/cooling", "Winston-Salem, NC"],
    ["café", "Montréal, QC"],
    ["auto repair (24h)", "St. Louis, MO"],
  ]) {
    assert.doesNotThrow(() => parseLookupRequest({ niche, city }), `${niche} / ${city}`);
  }
});

// ---------------------------------------------------------------------------
// Usage guardrails — must fail CLOSED
// ---------------------------------------------------------------------------

test("checkAllowance permits usage below both caps and reports what is left", () => {
  const v = checkAllowance({ usedToday: 0, usedThisMonth: 0 });
  assert.equal(v.allowed, true);
  assert.equal(v.remainingToday, LIMITS.perDay - 1);
  assert.equal(v.remainingThisMonth, LIMITS.perMonth - 1);
});

test("checkAllowance lets exactly the cap through and no more", () => {
  // The request under consideration is the (count+1)th, so at count = cap-1 it
  // is the cap'th and must be allowed; at count = cap it must not.
  assert.equal(checkAllowance({ usedToday: LIMITS.perDay - 1, usedThisMonth: 0 }).allowed, true);
  const refused = checkAllowance({ usedToday: LIMITS.perDay, usedThisMonth: 0 });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "daily_cap");
});

test("checkAllowance enforces the monthly cap ahead of the daily one", () => {
  // A fresh day inside an exhausted month must not reopen spending.
  const v = checkAllowance({ usedToday: 0, usedThisMonth: LIMITS.perMonth });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, "monthly_cap");
});

test("checkAllowance refuses on an unreadable ledger rather than assuming zero", () => {
  // This is the fail-open bug the whole guardrail would die of: if a failed
  // count were treated as 0 used, an outage would grant unlimited spending.
  for (const usage of [
    { usedToday: -1, usedThisMonth: -1 },
    { usedToday: null, usedThisMonth: 0 },
    { usedToday: 0, usedThisMonth: undefined },
    { usedToday: 1.5, usedThisMonth: 0 },
    {},
  ]) {
    const v = checkAllowance(usage);
    assert.equal(v.allowed, false, JSON.stringify(usage));
    assert.equal(v.reason, "ledger_unreadable");
  }
});

test("the caps stay well inside the SKU's free monthly allowance", () => {
  // The margin is the point: it is what keeps an accident free rather than
  // merely cheap. 31 maximum days of the daily cap must also stay inside it.
  assert.ok(LIMITS.perMonth < LIMITS.freeTierPerMonth);
  assert.ok(LIMITS.perDay * 31 <= LIMITS.freeTierPerMonth);
  assert.equal(BILLABLE_SKU, "places_text_search_pro");
});

test("ledger keys sort and filter by UTC day and month", () => {
  const now = new Date("2026-11-07T23:59:59.000Z");
  assert.equal(dayKey(now), "2026-11-07");
  assert.equal(monthKey(now), "2026-11");
  const key = ledgerKey("abc-123", now);
  assert.ok(key.startsWith("2026-11-07"), "a day prefix query must match");
  assert.ok(key.startsWith("2026-11"), "a month prefix query must match the same row");
  assert.notEqual(ledgerKey("def-456", now), key, "two lookups must not share a key");
});

// ---------------------------------------------------------------------------
// Ownership — anonymous and non-owner callers must not spend
// ---------------------------------------------------------------------------

test("bearerToken reads only the Authorization header", () => {
  assert.equal(bearerToken(req({ Authorization: "Bearer abc.def" })), "abc.def");
  assert.equal(bearerToken(req({ Authorization: "bearer abc" })), null, "scheme is case-sensitive");
  assert.equal(bearerToken(req({})), null);
  // A token in a URL leaks via logs and Referer; a cookie-authenticated POST
  // that spends money is a CSRF target. Neither is accepted.
  const withQuery = new Request("https://gapvera.example/api/places/search?access_token=abc");
  assert.equal(bearerToken(withQuery), null);
  assert.equal(bearerToken(req({ Cookie: "access_token=abc" })), null);
});

test("requireOwner refuses an anonymous caller before any Google work", async () => {
  await assert.rejects(() => requireOwner(req({}), ENV, ownerFetch()), (err) => {
    assert.ok(err instanceof RequestRefused);
    assert.equal(err.status, 401);
    assert.equal(err.reason, "no_token");
    return true;
  });
});

test("requireOwner refuses a signed-in non-owner", async () => {
  // Credentials fine, authorization absent: app_owner returns an empty array
  // because that read is itself RLS-gated.
  await assert.rejects(
    () => requireOwner(ownerReq(), ENV, ownerFetch({ ownerRows: [] })),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.reason, "not_owner");
      return true;
    }
  );
});

test("requireOwner refuses a revoked token", async () => {
  const impl = async (url) =>
    String(url).includes("/auth/v1/user")
      ? { ok: false, status: 401, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => [] };
  await assert.rejects(() => requireOwner(ownerReq(), ENV, impl), (err) => {
    assert.equal(err.status, 401);
    assert.equal(err.reason, "token_rejected");
    return true;
  });
});

test("requireOwner fails closed when Supabase is unreachable", async () => {
  const impl = async () => {
    throw new TypeError("network down");
  };
  await assert.rejects(() => requireOwner(ownerReq(), ENV, impl), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.reason, "supabase_unreachable");
    return true;
  });
});

test("requireOwner fails closed when the database has no schema", async () => {
  // An unprovisioned project 404s on app_owner. Ownership is undecidable, so
  // it must be denied — not assumed, and not reported as a login problem.
  const impl = async (url) =>
    String(url).includes("/auth/v1/user")
      ? { ok: true, status: 200, json: async () => ({ id: "uuid-erik" }) }
      : { ok: false, status: 404, json: async () => ({ code: "PGRST205" }) };
  await assert.rejects(() => requireOwner(ownerReq(), ENV, impl), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.reason, "owner_check_failed");
    // And it must not name an internal table to a caller.
    assert.ok(!/app_owner|schema cache|PGRST/.test(err.message), err.message);
    return true;
  });
});

test("requireOwner refuses when Supabase is unconfigured", async () => {
  await assert.rejects(() => requireOwner(ownerReq(), {}, ownerFetch()), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.reason, "supabase_unconfigured");
    return true;
  });
});

test("requireOwner accepts the owner and forwards the caller's own token", async () => {
  const impl = ownerFetch();
  const ctx = await requireOwner(ownerReq(), ENV, impl);
  assert.equal(ctx.userId, "uuid-erik");
  // The proxy authenticates AS THE CALLER. If it ever held a service_role key
  // it could bypass RLS, so this asserts the token it sends is the caller's.
  for (const call of impl.calls) {
    assert.equal(call.options.headers.Authorization, "Bearer caller-token");
  }
});

test("supabaseConfig prefers explicit server names over the client's build vars", () => {
  const cfg = supabaseConfig({ SUPABASE_URL: "https://a.co/", SUPABASE_PUBLISHABLE_KEY: "k", ...ENV });
  assert.equal(cfg.url, "https://a.co", "trailing slash trimmed");
  assert.equal(cfg.key, "k");
  assert.equal(supabaseConfig({}).configured, false);
});

// ---------------------------------------------------------------------------
// The ledger must count a request before it is spent
// ---------------------------------------------------------------------------

test("readUsage counts today and this month from Content-Range", async () => {
  const ctx = { supabase: { url: "https://p.co" }, authHeaders: {} };
  const seen = [];
  const impl = async (url) => {
    seen.push(String(url));
    return countRes(String(url).includes("2026-11-07") ? 3 : 11);
  };
  const usage = await readUsage(ctx, impl, new Date("2026-11-07T10:00:00Z"));
  assert.deepEqual(usage, { usedToday: 3, usedThisMonth: 11 });
  assert.ok(seen.every((u) => u.includes(`job=eq.${LEDGER_JOB}`)), "must filter to this job only");
});

test("readUsage returns null — not zero — when the ledger cannot be read", async () => {
  const ctx = { supabase: { url: "https://p.co" }, authHeaders: {} };
  const failures = [
    async () => ({ ok: false, status: 500, headers: { get: () => null } }),
    async () => ({ ok: true, status: 200, headers: { get: () => null } }),
    async () => ({ ok: true, status: 200, headers: { get: () => "*/notanumber" } }),
    async () => {
      throw new TypeError("offline");
    },
  ];
  for (const impl of failures) {
    assert.equal(await readUsage(ctx, impl), null);
  }
});

test("claimSlot records the spend before the Google call, with no Places content", async () => {
  const ctx = { supabase: { url: "https://p.co" }, authHeaders: {} };
  let body = null;
  const impl = async (url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 201, json: async () => [{ id: 7 }] };
  };
  const slot = await claimSlot(ctx, { niche: "plumber", city: "Miami" }, impl, new Date("2026-11-07T10:00:00Z"), "u1");
  assert.equal(slot.key, "2026-11-07:u1");
  assert.equal(body.job, LEDGER_JOB);
  assert.equal(body.status, "running");
  assert.equal(body.detail.sku, BILLABLE_SKU);
  assert.equal(body.detail.billable_events, 1);
  // Erik's own query text is his; Google's response is not. Only the former
  // is ever written here.
  assert.deepEqual(Object.keys(body.detail).sort(), ["billable_events", "city", "niche", "sku"]);
});

test("reserveLookup refuses rather than claiming when the ledger is unreadable", async () => {
  const ctx = { supabase: { url: "https://p.co" }, authHeaders: {} };
  let claimed = false;
  const impl = async (url, options = {}) => {
    if (options.method === "POST") {
      claimed = true;
      return { ok: true, status: 201, json: async () => [] };
    }
    return { ok: false, status: 500, headers: { get: () => null } };
  };
  await assert.rejects(() => reserveLookup(ctx, { niche: "a", city: "b" }, impl), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.reason, "ledger_unreadable");
    return true;
  });
  assert.equal(claimed, false, "nothing may be claimed when the cap cannot be evaluated");
});

test("reserveLookup refuses at the cap without claiming a slot", async () => {
  const ctx = { supabase: { url: "https://p.co" }, authHeaders: {} };
  let claimed = false;
  const impl = async (url, options = {}) => {
    if (options.method === "POST") {
      claimed = true;
      return { ok: true, status: 201, json: async () => [] };
    }
    return countRes(String(url).includes("-") && String(url).match(/\d{4}-\d{2}-\d{2}/) ? LIMITS.perDay : 0);
  };
  await assert.rejects(() => reserveLookup(ctx, { niche: "a", city: "b" }, impl), (err) => {
    assert.equal(err.reason, "daily_cap");
    return true;
  });
  assert.equal(claimed, false);
});

test("reserveLookup refuses when the ledger write itself fails", async () => {
  // A lookup that cannot be counted must not happen: otherwise a broken
  // ledger becomes an uncapped spending channel.
  const ctx = { supabase: { url: "https://p.co" }, authHeaders: {} };
  const impl = async (url, options = {}) =>
    options.method === "POST"
      ? { ok: false, status: 500, json: async () => ({}) }
      : countRes(0);
  await assert.rejects(() => reserveLookup(ctx, { niche: "a", city: "b" }, impl), (err) => {
    assert.equal(err.reason, "ledger_write_failed");
    assert.match(err.message, /not sent/);
    return true;
  });
});

test("reserveLookup reports the post-charge allowance honestly", async () => {
  const ctx = { supabase: { url: "https://p.co" }, authHeaders: {} };
  const impl = async (url, options = {}) =>
    options.method === "POST"
      ? { ok: true, status: 201, json: async () => [{ id: 1 }] }
      : countRes(String(url).match(/\d{4}-\d{2}-\d{2}/) ? 4 : 9);
  const { usage } = await reserveLookup(ctx, { niche: "a", city: "b" }, impl);
  // 4 were used, this is the 5th, so 5 used and cap-5 left.
  assert.equal(usage.usedToday, 5);
  assert.equal(usage.usedThisMonth, 10);
  assert.equal(usage.remainingToday, LIMITS.perDay - 5);
  assert.equal(usage.billableEvents, 1);
});

// ---------------------------------------------------------------------------
// Response shaping, attribution, and the persistence boundary
// ---------------------------------------------------------------------------

const googlePayload = {
  places: [
    {
      id: "ChIJ_has_site",
      displayName: { text: "Has Site Plumbing" },
      formattedAddress: "2 Oak Ave, Miami, FL",
      nationalPhoneNumber: "(305) 555-0100",
      websiteUri: "https://hassite.example",
      rating: 4.6,
      userRatingCount: 88,
      googleMapsUri: "https://maps.google.com/?cid=1",
      primaryTypeDisplayName: { text: "Plumber" },
    },
    {
      id: "ChIJ_no_site",
      displayName: { text: "No Site Plumbing" },
      formattedAddress: "3 Elm St, Miami, FL",
      rating: 4.9,
      userRatingCount: 12,
      googleMapsUri: "https://maps.google.com/?cid=2",
      attributions: [{ provider: "Example Data Co", providerUri: "https://example.test" }],
    },
  ],
};

test("shapeLookupResponse surfaces no-website prospects first", () => {
  const out = shapeLookupResponse(googlePayload, { niche: "plumber", city: "Miami" }, { usedToday: 1 });
  assert.equal(out.count, 2);
  assert.equal(out.results[0].business_name, "No Site Plumbing");
  assert.equal(out.results[0].has_website, false);
});

test("orderForPitch keeps Google's relevance order within each group", () => {
  // Reordering is presentation. Re-RANKING would be deriving content from
  // Google Maps Content, which 3.2.3(c) forbids, so ties must not be resorted.
  const input = [
    { business_name: "A", has_website: true },
    { business_name: "B", has_website: false },
    { business_name: "C", has_website: true },
    { business_name: "D", has_website: false },
  ];
  assert.deepEqual(
    orderForPitch(input).map((p) => p.business_name),
    ["B", "D", "A", "C"]
  );
});

test("shapeLookupResponse carries the attribution the licence requires", () => {
  const out = shapeLookupResponse(googlePayload, { niche: "plumber", city: "Miami" }, {});
  assert.equal(out.attribution.poweredByGoogle, true);
  assert.match(out.attribution.logoUrl, /^https:\/\/maps\.gstatic\.com\//);
  assert.match(out.attribution.notice, /not stored/i);
  // Every result links back to its Google Maps entry.
  assert.ok(out.results.every((p) => p.google_maps_uri.startsWith("https://")));
  // Third-party provider attributions are preserved, not dropped.
  const withProvider = out.results.find((p) => p.place_id === "ChIJ_no_site");
  assert.deepEqual(withProvider.attributions, [
    { provider: "Example Data Co", uri: "https://example.test" },
  ]);
});

test("shapeLookupResponse states plainly that nothing is persisted", () => {
  const out = shapeLookupResponse(googlePayload, { niche: "plumber", city: "Miami" }, {});
  assert.equal(out.persistence.savesToCrm, false);
  assert.deepEqual(out.persistence.storableFields, ["place_id"]);
  assert.match(out.persistence.reason, /3\.2\.3/);
});

test("cacheablePlaceFields exposes the place ID and nothing else", () => {
  // This is the licence boundary in code: the Service Specific Terms exempt
  // the place ID from the caching restriction and exempt nothing else. If this
  // assertion ever needs updating, the terms — not the convenience — must have
  // changed.
  const shaped = shapePlace(googlePayload.places[0]);
  assert.deepEqual(Object.keys(cacheablePlaceFields(shaped)), ["place_id"]);
  assert.equal(cacheablePlaceFields(shaped).place_id, "ChIJ_has_site");
});

test("shapePlace reports rather than derives, and never invents", () => {
  const sparse = shapePlace({ id: "x", displayName: { text: "Sparse Co" } });
  // Absent numbers stay null instead of becoming 0, which would read as a real
  // zero rating and would be content GapVera made up.
  assert.equal(sparse.rating, null);
  assert.equal(sparse.review_count, null);
  assert.equal(sparse.has_website, false);
  assert.equal(sparse.attributions.length, 0);
  // No score, no grade, no derived field of any kind.
  assert.deepEqual(Object.keys(sparse).sort(), [
    "address",
    "attributions",
    "business_name",
    "category",
    "google_maps_uri",
    "has_website",
    "phone",
    "place_id",
    "rating",
    "review_count",
    "website_url",
  ]);
  assert.ok(!("lead_score" in sparse), "a lead score here would be derived content");
});

test("shapeLookupResponse drops results with no business name", () => {
  const out = shapeLookupResponse({ places: [{ id: "x" }, ...googlePayload.places] }, { niche: "a", city: "b" }, {});
  assert.equal(out.count, 2);
});

test("shapeLookupResponse handles an empty or malformed payload without throwing", () => {
  for (const payload of [null, {}, { places: [] }, { places: null }]) {
    const out = shapeLookupResponse(payload, { niche: "a", city: "b" }, {});
    assert.equal(out.count, 0);
    assert.deepEqual(out.results, []);
  }
});

// ---------------------------------------------------------------------------
// Google failures must never leak Google's message
// ---------------------------------------------------------------------------

test("classifyGoogleFailure maps statuses and never forwards Google's text", () => {
  // Google's error.message can echo the request and name the project, so the
  // proxy substitutes its own wording in every case. What must never appear is
  // a credential VALUE or Google's own prose — naming "the API key" as the
  // thing an operator should check is useful and leaks nothing.
  const cases = [
    [400, undefined, 502],
    [401, undefined, 503],
    [403, undefined, 503],
    [429, undefined, 429],
    [200, "RESOURCE_EXHAUSTED", 429],
    [500, undefined, 502],
  ];
  for (const [status, googleStatus, expected] of cases) {
    const out = classifyGoogleFailure(status, googleStatus);
    assert.equal(out.status, expected, `${status}/${googleStatus}`);
    assert.ok(out.message.length > 0);
    // No key-shaped literal, no Google project identifier, no raw API status.
    assert.ok(!/AIza[0-9A-Za-z_-]{10,}/.test(out.message), out.message);
    assert.ok(!/projects\/\d+|project[_ ]number/i.test(out.message), out.message);
    assert.ok(!/PERMISSION_DENIED|INVALID_ARGUMENT|RESOURCE_EXHAUSTED/.test(out.message), out.message);
  }
});

test("a credentials failure is reported as configuration, not as the user's fault", () => {
  const out = classifyGoogleFailure(403);
  assert.match(out.message, /API key|restrictions/i);
  assert.match(out.message, /no lookup was performed/i);
});

// ---------------------------------------------------------------------------
// Request shape sent to Google
// ---------------------------------------------------------------------------

test("one lookup is exactly one page of one request", () => {
  // Paging would multiply billable events per click. PAGE_SIZE is the single
  // request's size, and there is no pagination token plumbing anywhere.
  assert.equal(PAGE_SIZE, 20);
  assert.ok(PAGE_SIZE <= 20, "Places caps pageSize at 20; a larger value 400s");
});
