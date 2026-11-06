# GapVera zero-cost migration — status

Task `t_9c4aa30f`. Assessed against `handoff/zero-cost/acceptance.md`.

Status vocabulary is deliberate (acceptance criterion 14). **Implemented** means
code exists. **Tests passing** means automated tests cover it and pass.
**Locally verified** means it was executed against a real Postgres and a real
browser on this machine. **Provider-configured**, **deployed**, and
**live-verified** mean exactly what they say — and none of those three are
claimed anywhere below.

## Blocker

**No Supabase or Cloudflare account exists, and no credential for either is
available to this session.** Verified, not assumed:

- Hermes credential vault: no Supabase or Cloudflare item.
- No `supabase` or `wrangler` CLI installed.
- `~/.supabase`, `~/.wrangler`, `~/.cloudflared`: absent or empty.
- No `SUPABASE_*` / `CLOUDFLARE_*` / `CF_*` variables in the environment.
- No `.env` files anywhere in the repo.

The Supabase project ref named in earlier notes (`iwmdfapdzyqfzhdgzdpa`) does
resolve — `/rest/v1/` and `/auth/v1/health` both return HTTP 401 `No API key
found`, which proves the project exists but that this session holds no key for
it.

GitHub push is separately blocked: `gh` is authenticated as `scorpioswaggs`,
but `Scorpionswag/gapvera` reports `viewerPermission: READ` and a
`git push --dry-run` to a throwaway ref was rejected with 403.

Everything from "create the project" onward is therefore blocked. Creating
these accounts requires email verification and CAPTCHA, which is a human step.

### Resolved: the npm-install blocker

A previous run could not install `@supabase/supabase-js` (the package-security
scanner refuses unattended installs) and concluded the client could not be
ported. **That is no longer a blocker.** The client now talks to Supabase
through a hand-written, dependency-free client:

```
client/src/supabase.js    GoTrue (auth) + PostgREST (data) + Storage over fetch
```

Nothing was installed. `npm run build` is green and the bundle is 437 kB.

## Per-criterion status

| # | Criterion | Status |
|---|---|---|
| 1 | Pages serves frontend at public HTTPS while computer off | **Blocked** — no Cloudflare account. Build config + SPA `_redirects` ready and the fallback behaviour is locally verified. |
| 2 | No paid plan, trial, card, or purchased domain | **Held** — nothing was signed up for or purchased. Zero spend. The CARTO basemap, which now needs a paid key, was replaced rather than paid for (criterion 9). |
| 3 | Supabase Auth; signup disabled; anon blocked from CRM | **Implemented + locally verified.** Against real Postgres: `anon` is refused on `leads` and `documents` at the privilege layer, cannot insert, and an authenticated non-owner sees 0 of 17 leads. The UI states that public signup is disabled and offers no register form. The dashboard toggle that enforces it server-side still needs the account (`supabase/README.md` step 4). |
| 4 | Verified migrated copy reconciles against SQLite export | **Implemented + locally verified end-to-end.** `data.sql` was imported into a real Postgres 15, every table read back out as CSV, and `reconcile.mjs` matched all 7 per-table checksums and all foreign keys: *"RECONCILED — 21 row(s) across 7 table(s) match the preserved SQLite export."* |
| 5 | CRM CRUD from a phone on cellular | **Implemented + locally verified; not deployed.** A full create → read → update → delete round-trip ran from the browser against real Postgres, leaving the 17 migrated leads intact. Mobile layout verified at 390 px (below). Cellular itself needs a deployment. |
| 6 | Documents in private Storage, signed access only | **Implemented + locally verified (SQL).** `0002_storage.sql` *refuses to apply* against a public bucket — tested both ways: it aborted on a public bucket and applied cleanly on a private one. `DocLink.jsx` mints a signed URL per click, because a private bucket has no durable `href`. |
| 7 | No localhost/LAN/secret/service-role key in bundle | **Verified on the shipped bundle.** Scanned `client/dist` after a production build: no JWT, no `service_role`, no credential, zero `localhost`/`127.0.0.1`/LAN matches, no stale `/api/` paths, and none of the local dogfood credentials. |
| 8 | Logout, expiry, direct API/Storage calls fail closed | **Implemented + locally verified.** Four paths each returned 401: tampered token, no token, direct Storage sign with no token, and a token reused after logout. On reload with a revoked token the app shows "Your session expired", clears the stored session, and leaks no lead data into the DOM. |
| 9 | Map renders with attribution, no exposed credential | **Fixed this session + locally verified.** CARTO was silently broken (see below); the map now uses OpenStreetMap with required attribution and no credential at all. |
| 10 | Durable job records; retries don't duplicate mutations | **Implemented + locally verified (SQL).** The unique index on `(job, idempotency_key)` was exercised against real Postgres: a duplicate claim for the same period is rejected, a new period still claims. A cross-day duplicate-draft bug in the Edge Function was found and fixed (see below). Not deployed, so not live-verified. |
| 11 | Scraping/SMTP visibly unavailable, no fake success | **Implemented + locally verified.** The Scrape page shows an UNAVAILABLE badge, explains why, and offers CSV import — no dead search box. The Outreach composer says "DRAFTS ONLY — SENDING IS UNAVAILABLE" and offers *Save draft* / *Copy for sending*. Verified in the database: saving a draft writes `status='draft'` and leaves `outreach_status` and `last_contact_date` untouched, so nothing claims a send that did not happen. Email discovery and site auditing are likewise marked unavailable rather than stubbed. |
| 12 | Hosted desktop + mobile dogfood passes | **Locally verified; hosted pass still required.** All 9 routes mount with real data at desktop width and at 390 px with **zero** horizontal overflow. Two real bugs were found by this pass and fixed (below). The acceptance gate explicitly demands this on the *real hosted product*, so this criterion is **not** closed. |
| 13 | Rollback/export artifact + documented restore rehearsal | **Done and rehearsed.** See below. Source SQLite is byte-identical after all of this session's work. |
| 14 | Handoff distinguishes status levels | **This document.** |

## The SQL migrations have now been executed

The previous status said the SQL had "never been run" because there was no
Postgres and no Docker daemon. Colima was available but stopped; starting it
made this testable. All three migrations were executed against a real
PostgreSQL 15 container, with a small shim supplying the Supabase-provided
objects (`auth.users`, `auth.uid()`, `storage.*`, the `anon`/`authenticated`
roles) that a bare Postgres lacks.

Result: **`0001_schema.sql` applied cleanly on the first attempt.** The warning
to "expect to fix a syntax issue on first apply" no longer applies.

`migration/test-harness/` holds the harness:

```
00-supabase-shim.sql    Supabase-provided objects, for a bare Postgres
10-rls-assertions.sql   16 RLS/security assertions, each RAISEs on the wrong outcome
pg-readback.mjs         reads every table back out as CSV for reconcile.mjs
mock-supabase.mjs       PostgREST/GoTrue/Storage stand-in over the same Postgres
serve-spa.mjs           static server with SPA history fallback
build-debug.sh          unminified + sourcemapped build, for real stack traces
```

The RLS assertions are behavioural, not structural — they impersonate the roles
PostgREST uses and check what actually comes back. All 16 pass, including two
privilege-escalation attempts that must fail:

- an authenticated owner **cannot** grant ownership to another account
  (`app_owner` is select-only; otherwise a leaked anon key plus any signup
  would be a full takeover);
- a `search_path` hijack — attacker creates their own `app_owner` table in a
  schema that resolves first — **does not** grant access, because `is_owner()`
  pins `search_path`. Checked both structurally (`proconfig`) and behaviourally.

**What this does not prove:** the harness is not a Supabase emulator. It shows
the SQL is valid, the policies behave correctly, and the client's request
shapes are right. It says nothing about Supabase's own hosted behaviour, and
the `mock-supabase.mjs` stand-in deliberately does **not** enforce RLS — that
is what the assertions file is for.

## Bugs found and fixed during this session

### 1. The map was broken and failing silently (criterion 9)

The Territory page used CARTO's keyless `dark_all` raster tiles. As of
25 Sep 2026 CARTO requires an API key, and — worse than a clean failure — a
keyless request returns **HTTP 200 with a byte-identical "API KEY REQUIRED"
placeholder image**. To curl, to Leaflet, and to a glance at the page, the map
"loads"; it just shows a wall of identical placeholder tiles.

Measured, not assumed: four tiles from Miami, Hialeah, Denver and Seattle all
hashed to `cc3f31364a735d9a`. The same four from OpenStreetMap were distinct
real imagery.

Fixed by switching to OpenStreetMap, which is free and needs no credential —
which also satisfies criterion 9's "no exposed private credential" by having
none to expose. The design's dark treatment is preserved with a CSS filter on
the tile layer only, so markers and attribution keep their real colours.
`migration/test-harness/tile-probe.mjs` reproduces the check.

### 2. A ReferenceError crashed the Outreach page

Removing the email-discovery feature left a `setFoundEmails(null)` call behind
after its `useState` was deleted. This is invisible to the bundler — it is
valid JavaScript — so the build stayed green and the page white-screened the
moment a lead was selected. It was caught only by clicking through the app.

Fixed, and the bug *class* is now covered: `client/src/deadrefs.test.mjs`
scans every component for `setX(...)` calls with no declaration in scope. It
was validated by reintroducing the real bug (test fails, naming
`pages/Outreach.jsx:75`) and removing it again (test passes).

### 3. The follow-up sweep would re-draft the same lead every day

`followup-sweep` correctly never advances `outreach_status` (nothing was
actually sent), but that means a due lead stays due forever. The daily
idempotency key prevents double-runs *within* a day, so this was invisible to
the existing idempotency test — across days it would have produced a new
duplicate draft for the same lead indefinitely. Now guarded by a per-stage
draft check.

### 4. (Pre-existing, from the earlier run) `cp` would have broken the rollback

The first snapshot implementation used `fs.copyFileSync`. A test that moved the
copy and reopened it read-only failed with SQLite error 14. Root cause: `crm.db`
is WAL-mode, and a WAL database needs to create a `-shm` sidecar on open, which
read-only mode refuses. **A `cp`-based rollback artifact would have been
unusable at exactly the moment it was needed.** Replaced with `VACUUM INTO`.

## Criterion 13 evidence (restore rehearsal, executed)

```
$ node migration/export-sqlite.mjs ~/gapvera/server/crm.db migration/export
snapshot: migration/export/crm.snapshot.db (integrity_check ok)
exported 21 row(s) across 7 table(s)
  leads               17  996314deac6df4fc
  clients              0  e3b0c44298fc1c14
  calls                0  e3b0c44298fc1c14
  email_templates      4  24e826b5fcf5b930
  email_logs           0  e3b0c44298fc1c14
  documents            0  e3b0c44298fc1c14
  invoices             0  e3b0c44298fc1c14
excluded (not migrated): auth_admin, auth_sessions, auth_failures, auth_lockout
```

And this session's end-to-end reconciliation against real Postgres:

```
$ node migration/test-harness/pg-readback.mjs gapvera-sqltest gapvera /tmp/gv-pg-readback
$ node migration/reconcile.mjs migration/export /tmp/gv-pg-readback
  OK    leads               17 row(s)  996314deac6df4fc
  OK    clients              0 row(s)  e3b0c44298fc1c14
  OK    calls                0 row(s)  e3b0c44298fc1c14
  OK    email_templates      4 row(s)  24e826b5fcf5b930
  OK    email_logs           0 row(s)  e3b0c44298fc1c14
  OK    documents            0 row(s)  e3b0c44298fc1c14
  OK    invoices             0 row(s)  e3b0c44298fc1c14
  OK    relationships    all foreign keys resolve

RECONCILED — 21 row(s) across 7 table(s) match the preserved SQLite export.
```

Note the `leads` checksum `996314deac6df4fc` is identical on both sides — the
same hash the SQLite export produced, recomputed from what Postgres returned.

**Source preserved.** `server/crm.db` SHA-256 is
`c9ae6abb19b946f3fa7479e14e6629e93725c4e9a1dec9a1fec0ac0798c50a1b`,
byte-identical before and after all of this session's work. The Express server
in `server/` is deliberately **retained**, not deleted: criterion 13 requires
the source SQLite data to survive, and `server/` is its only reader.

## Tests

```
$ npm test
ℹ tests 99
ℹ pass 99
ℹ fail 0
```

| File | Covers |
|---|---|
| `migration/migration.test.mjs` | export + reconcile tooling (29) |
| `client/src/crmLogic.test.mjs` | business rules ported out of the Express server |
| `client/src/csvImport.test.mjs` | the CSV importer that replaced scraping |
| `client/src/supabase.test.mjs` | session handling in the hand-written auth client |
| `client/src/deadrefs.test.mjs` | undeclared state setters (bug 2 above) |

The `crmLogic` suite pins the ported lead scorer against a *real migrated row*:
Riverside Plumbing Co must still compute to its stored `lead_score` of 99.

`supabase.test.mjs` exists specifically because the auth layer is hand-written:
it covers expiry, concurrent-refresh collapsing, and fail-closed behaviour on a
revoked token.

## What a human needs to do to unblock

1. Create a Supabase account + Free project, and a Cloudflare account
   (no card, no trial, Free tiers only).
2. Make the credentials available through the Hermes vault — **not** in chat,
   not in a file in this repo.
3. Grant push access to `Scorpionswag/gapvera` for the authenticated GitHub
   user, or nominate a different remote.

Then the remaining work is mechanical: apply the three SQL migrations, import
`migration/export/data.sql`, re-run `reconcile.mjs` against the real project,
create the first auth user, disable public signup, deploy to Pages with
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, and run the hosted dogfood
pass that criterion 12's gate requires.

## Files added by this task

```
client/src/supabase.js                     dependency-free GoTrue + PostgREST + Storage
client/src/crmLogic.js                     business rules ported from the server (pure)
client/src/csvImport.js                    CSV lead import, extracted for testing
client/src/components/DocLink.jsx          per-click signed URL for private Storage
client/src/crmLogic.test.mjs               ported-rule tests
client/src/csvImport.test.mjs              importer tests
client/src/supabase.test.mjs               session/auth tests
client/src/deadrefs.test.mjs               undeclared-setter lint
migration/test-harness/*                   local Postgres + browser verification rig
supabase/migrations/0001_schema.sql        CRM schema + owner-only RLS + job_runs
supabase/migrations/0002_storage.sql       private documents bucket policies
supabase/migrations/0003_cron.sql          daily sweep schedule
supabase/functions/followup-sweep/index.ts idempotent draft-only sweep
supabase/README.md                         provider setup runbook (no secrets)
migration/export-sqlite.mjs                read-only export + VACUUM INTO snapshot
migration/reconcile.mjs                    import verification (criterion 4)
migration/migration.test.mjs               migration tooling tests
migration/README.md                        tooling docs + design rationale
client/public/_redirects                   SPA deep-link support for Pages
```

Rewritten: `client/src/api.js` (browser → Supabase, same export surface),
`client/src/pages/Auth.jsx`, `client/src/pages/Scrape.jsx`.
Modified: `client/src/App.jsx`, `client/src/pages/Outreach.jsx`,
`client/src/components/LeadModal.jsx`, `client/src/pages/Clients.jsx`,
`client/src/pages/Ledger.jsx`, `client/src/pages/Territory.jsx`,
`client/src/index.css`, `package.json`, `.gitignore`.
