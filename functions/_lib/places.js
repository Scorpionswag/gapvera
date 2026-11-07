// Pure logic for the authorized Google Places lookup proxy.
//
// Everything here is side-effect free so it can be unit-tested with
// `node --test` without a Cloudflare runtime, a Supabase project, or a Google
// API key. The handler in functions/api/places/search.js does the I/O and
// nothing else of consequence.
//
// ---------------------------------------------------------------------------
// Compliance contract (Google Maps Platform ToS 3.2.3 + Places API policies)
// ---------------------------------------------------------------------------
// Erik authorized chargeable Places usage on 2026-11-07. Authorization to
// spend is not authorization to ignore the licence, so this module encodes the
// parts of the terms that are mechanical:
//
//   * 3.2.3(a) No Scraping / (b) No Caching — Places content is passed through
//     to the browser for the life of one lookup and is never written to the
//     CRM. `cacheablePlaceFields` is the ONLY projection permitted to be
//     persisted: the place ID, which the Service Specific Terms exempt from
//     the caching restriction and allow to be stored indefinitely.
//   * 3.2.3(c) No Creating Content From Google Maps Content — no scoring, no
//     derived fields, no geocode reuse. `shapePlace` copies and renames; it
//     never computes.
//   * 3.2.3(e) No Use With Non-Google Maps — GapVera's Territory map is
//     OpenStreetMap, so latitude/longitude are deliberately NOT requested
//     (see FIELD_MASK) and `shapePlace` drops them if a future mask change
//     lets them through. Places content cannot reach a non-Google map if the
//     coordinates never arrive.
//   * Attribution — every result carries its Google Maps URI and any
//     third-party attributions, and the client renders the Google logo. The
//     response is marked no-store so neither the browser nor Cloudflare's
//     cache retains it.
//
// ---------------------------------------------------------------------------
// Cost contract
// ---------------------------------------------------------------------------
// One lookup is exactly one `places:searchText` request = one billable
// "Places API Text Search Pro" event. That SKU's free allowance is 5,000
// events/month. The caps below are a small fraction of it, so a runaway loop
// or a stuck retry cannot reach the paid tier before the cap stops it.

/** Billable SKU this proxy spends against. Recorded on every ledger row. */
export const BILLABLE_SKU = 'places_text_search_pro';

/**
 * Guardrails. Deliberately far below the 5,000/month free allowance for the
 * Text Search Pro SKU: the gap is the margin that keeps an accident free.
 */
export const LIMITS = Object.freeze({
  perDay: 25,
  perMonth: 300,
  /** Free monthly events for the SKU, for honest "x of the free tier" copy. */
  freeTierPerMonth: 5000,
});

/** The ledger job name. Rows live in public.job_runs under owner-only RLS. */
export const LEDGER_JOB = 'places_search';

/**
 * Exactly the fields the lookup needs, and nothing more. A narrow mask is both
 * a cost control (Places bills by SKU tier, and asking for more fields can
 * promote the request to a dearer SKU) and the compliance boundary above:
 * `places.location` is absent on purpose so coordinates never arrive.
 */
export const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.googleMapsUri',
  'places.primaryTypeDisplayName',
  'places.attributions',
].join(',');

export const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

/** Results requested per lookup. One request regardless, so one billable event. */
export const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const MAX_FIELD = 80;
// Letters (incl. accented), digits, space and a few separators that appear in
// real place and city names. Everything else is refused rather than stripped,
// so a caller is told its input was rejected instead of silently searching for
// something else.
const SAFE_TEXT = /^[\p{L}\p{N} .,'&/()-]+$/u;

export class InvalidInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidInput';
  }
}

function cleanField(raw, label) {
  if (typeof raw !== 'string') throw new InvalidInput(`${label} is required.`);
  // Control characters are refused BEFORE whitespace is collapsed. Collapsing
  // first would turn "plumber\n\rX" into the perfectly valid "plumber X" and
  // silently search for something the caller did not type — and a silently
  // corrected query still costs a billable event.
  if (/[\p{Cc}\p{Cf}]/u.test(raw)) {
    throw new InvalidInput(`${label} contains a control character.`);
  }
  // Collapse the remaining whitespace: " plumber  " and "plumber" are the same
  // query and must not consume two different ledger slots.
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) throw new InvalidInput(`${label} is required.`);
  if (value.length > MAX_FIELD) {
    throw new InvalidInput(`${label} must be ${MAX_FIELD} characters or fewer.`);
  }
  if (!SAFE_TEXT.test(value)) {
    throw new InvalidInput(`${label} may only contain letters, numbers, spaces and . , ' & / ( ) -`);
  }
  // Must begin with a letter or digit. The allowlist has to permit `.` and `/`
  // for real names ("St. Louis", "heating/cooling"), which also admits junk
  // like "../../etc" — harmless here (the value only ever becomes a JSON
  // string field, never a URL path) but still a lookup nobody meant to run,
  // and every lookup is a billable request.
  if (!/^[\p{L}\p{N}]/u.test(value)) {
    throw new InvalidInput(`${label} must start with a letter or a number.`);
  }
  return value;
}

/**
 * Validate and normalize a lookup request body.
 *
 * Returns `{ niche, city, textQuery }`. Throws InvalidInput with a
 * human-readable reason — never a 500, and never a silently-corrected query,
 * because a corrected query still costs a billable event and the operator
 * would be paying for a search they did not ask for.
 */
export function parseLookupRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvalidInput('Expected a JSON object with "niche" and "city".');
  }
  const unknown = Object.keys(body).filter((k) => k !== 'niche' && k !== 'city');
  if (unknown.length) {
    throw new InvalidInput(`Unexpected field(s): ${unknown.join(', ')}.`);
  }
  const niche = cleanField(body.niche, 'Business type');
  const city = cleanField(body.city, 'City');
  return { niche, city, textQuery: `${niche} in ${city}` };
}

// ---------------------------------------------------------------------------
// Usage guardrails
// ---------------------------------------------------------------------------

/** UTC day key, `YYYY-MM-DD`. Ledger keys are prefixed with it. */
export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** UTC month prefix, `YYYY-MM`. */
export function monthKey(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

/**
 * A ledger key that is unique per lookup but still greppable by day and month,
 * so the counts above are a prefix query rather than a second table.
 */
export function ledgerKey(uuid, now = new Date()) {
  return `${dayKey(now)}:${uuid}`;
}

/**
 * Decide whether a lookup may proceed, given how many are already on the
 * ledger. Pure so the policy is testable without burning a request.
 *
 * Counts are of rows ALREADY recorded, so the request being considered is the
 * (count + 1)th. `>=` is therefore correct: at a cap of 25, the 26th is
 * refused and exactly 25 run.
 */
export function checkAllowance({ usedToday, usedThisMonth }, limits = LIMITS) {
  if (!Number.isInteger(usedToday) || !Number.isInteger(usedThisMonth) || usedToday < 0 || usedThisMonth < 0) {
    // An unreadable ledger must not read as "zero used". Fail closed.
    return {
      allowed: false,
      reason: 'ledger_unreadable',
      message: 'GapVera could not read its own usage ledger, so the lookup was not sent.',
    };
  }
  if (usedThisMonth >= limits.perMonth) {
    return {
      allowed: false,
      reason: 'monthly_cap',
      message: `Monthly lookup cap reached (${limits.perMonth}). It resets on the 1st.`,
    };
  }
  if (usedToday >= limits.perDay) {
    return {
      allowed: false,
      reason: 'daily_cap',
      message: `Daily lookup cap reached (${limits.perDay}). It resets at 00:00 UTC.`,
    };
  }
  return {
    allowed: true,
    remainingToday: limits.perDay - usedToday - 1,
    remainingThisMonth: limits.perMonth - usedThisMonth - 1,
  };
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

/**
 * Project one Google place onto the wire shape the client renders.
 *
 * Copies and renames only. It computes nothing, derives nothing, and drops
 * anything not explicitly listed — including `location`, which must never
 * reach a client whose map is OpenStreetMap (ToS 3.2.3(e)).
 */
export function shapePlace(p) {
  const place = p || {};
  const website = typeof place.websiteUri === 'string' ? place.websiteUri : '';
  return {
    // The place ID. The one field the Service Specific Terms exempt from the
    // caching restriction, and therefore the only one GapVera may store.
    place_id: typeof place.id === 'string' ? place.id : '',
    business_name: place.displayName?.text || '',
    address: place.formattedAddress || '',
    phone: place.nationalPhoneNumber || '',
    website_url: website,
    // Reported, not derived: this is Google's own presence/absence of a site,
    // restated for display. No score, no judgement, no new content.
    has_website: Boolean(website),
    rating: typeof place.rating === 'number' ? place.rating : null,
    review_count: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    category: place.primaryTypeDisplayName?.text || '',
    // Required attribution: every result links back to its Google Maps entry.
    google_maps_uri: typeof place.googleMapsUri === 'string' ? place.googleMapsUri : '',
    // Third-party data-provider attributions, when Google supplies them.
    attributions: Array.isArray(place.attributions)
      ? place.attributions
          .map((a) => ({
            provider: a?.provider || '',
            uri: typeof a?.providerUri === 'string' ? a.providerUri : '',
          }))
          .filter((a) => a.provider)
      : [],
  };
}

/**
 * The only projection of a Places result GapVera is permitted to persist.
 *
 * Place IDs are exempt from the caching restriction; everything else is not.
 * Exported so the UI's export path and any future persistence have one obvious
 * correct answer to "what can I keep?" — and so a test can assert that answer
 * has not quietly grown.
 */
export function cacheablePlaceFields(shaped) {
  return { place_id: shaped?.place_id || '' };
}

/**
 * Order results so businesses with no website come first — that is the pitch
 * GapVera exists to make.
 *
 * This is presentation order, not derived content: it reorders Google's own
 * results using a field Google returned, and stores nothing. Ties keep
 * Google's relevance ranking, so the API's own ordering is preserved within
 * each group rather than replaced by one of GapVera's own.
 */
export function orderForPitch(places) {
  return [...places]
    .map((p, i) => [p, i])
    .sort(([a, ai], [b, bi]) => (a.has_website ? 1 : 0) - (b.has_website ? 1 : 0) || ai - bi)
    .map(([p]) => p);
}

/**
 * Turn a Places `searchText` payload into the lookup response body.
 *
 * `usage` carries the honest post-request allowance so the UI can show the
 * real cost position instead of an optimistic guess.
 */
export function shapeLookupResponse(googleBody, { niche, city }, usage) {
  const places = orderForPitch((googleBody?.places || []).map(shapePlace).filter((p) => p.business_name));
  return {
    query: { niche, city },
    results: places,
    count: places.length,
    usage,
    // Rendered by the UI, not decoration: the licence that permits this call
    // requires the attribution and forbids retaining the content.
    attribution: {
      poweredByGoogle: true,
      logoUrl: 'https://maps.gstatic.com/mapfiles/api-3/images/powered-by-google-on-non-white3.png',
      notice: 'Business details from Google Maps. Shown live and not stored by GapVera.',
    },
    // Machine-readable statement of the reduced behaviour, so the UI cannot
    // drift into implying leads were saved.
    persistence: {
      savesToCrm: false,
      storableFields: ['place_id'],
      reason:
        'Google Maps Platform Terms 3.2.3(a)-(b) forbid storing Places content. Only the place ID is exempt.',
    },
  };
}

/**
 * Map a Google Places failure onto a status and a message safe to show a
 * human. Google's own `error.message` can echo the request and name the
 * project, so it is never forwarded.
 */
export function classifyGoogleFailure(status, googleStatus) {
  if (status === 400) {
    return { status: 502, message: 'Google rejected the lookup request. Nothing was charged for a result.' };
  }
  if (status === 401 || status === 403) {
    return {
      status: 503,
      message:
        'Google refused GapVera\'s credentials for this lookup. The API key or its restrictions need attention; no lookup was performed.',
    };
  }
  if (status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    return {
      status: 429,
      message: 'Google is rate-limiting or has exhausted the quota for this project. Try again later.',
    };
  }
  return { status: 502, message: 'Google Places did not answer successfully. No results were returned.' };
}
