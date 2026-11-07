# GapVera zero-cost migration — status

Task `t_129b1c12` (provision production Supabase + verify login; supersedes
`t_46fd6cfc`, which superseded `t_961bc97c`).
Assessed against `handoff/zero-cost/acceptance.md`.

Status vocabulary is deliberate (acceptance criterion 14). **Implemented** means
code exists. **Tests passing** means automated tests cover it and pass.
**Locally verified** means it was executed against a real Postgres and a real
browser on this machine. **Provider-configured**, **deployed**, and
**live-verified** mean exactly what they say.

## 2026-11-07, task t_129b1c12 — provisioning prepared, apply still blocked

**The production database is still unprovisioned, and this session could not
provision it.** Re-measured at the start of this run, against the live project
using the publishable key extracted from the deployed bundle:

| Probe | Result |
|---|---|
| `/rest/v1/{app_owner,leads,clients,calls,documents,invoices,email_templates,email_logs,job_runs}` | all 404 `PGRST205` |
| `/rest/v1/rpc/is_owner` | 404 `PGRST202` |
| `/auth/v1/health` | 200, GoTrue v2.197.0 — Auth healthy |
| `https://gapvera.pages.dev` | 200, `cf-ray` present, bundle `index-jDw9CGWA.js` |

Why the apply could not happen here, verified rather than assumed:

- The Supabase SQL editor **is** open and authenticated in Erik's Chrome
  (GapVera / `main` PRODUCTION, Free plan) — confirmed by screenshot.
- Driving that window requires desktop input, which this unattended run is
  not permitted to perform (`computer_use` click/type refused: approval
  required, no user present).
- The agent's own browser is a *separate* session and is signed out; it lands
  on the Supabase sign-in page. The credential vault holds no Supabase item,
  and a headless session cannot prompt for one.
- No `supabase` CLI, no `psql`, no `wrangler` on the host; `~/.supabase`,
  `~/.config/supabase`, `~/.netrc` all absent; no `SUPABASE_*`/`CLOUDFLARE_*`
  environment variables.

Asking for the password in chat is forbidden by the task and by the locked
safety decisions, so the apply is Erik's to trigger. **What this session did
instead was remove every remaining manual step except that one click.**

### Provisioning is now a single paste

Previously the runbook was six ordered editor pastes plus two dashboard
object-creations, and a skipped or half-pasted step produces a project that
looks migrated and 404s at first login — precisely the 2026-11-06 failure.
Now:

```sh
node supabase/build-provision-sql.mjs      # -> migration/export/provision.sql
```

One file, pasted once, idempotent, self-verifying. Changes that made that
possible:

- **`supabase/migrations/0002_storage.sql`** now *creates* the `documents`
  bucket private if it is absent, instead of requiring a prior dashboard
  click. It still refuses outright if the bucket already exists and is public
  — an existing bucket's visibility is never silently rewritten.
- **`supabase/migrations/0004_grant_owner.sql`** (new) resolves Erik's account
  from `auth.users` instead of requiring his email address to be typed into a
  query and echoed in a result grid. It is the ownership step that was README
  prose. It **refuses rather than guess**: zero accounts raises with what to
  do, and more than one raises with the explicit by-uuid statement, because
  picking "the first" would hand sole ownership of the CRM to an arbitrary
  row. Re-running after the row exists is a no-op.
- **`supabase/build-provision-sql.mjs`** (new) concatenates schema → storage →
  ownership → data in the only order that works, and appends a final block
  that raises unless all 9 RLS tables, `is_owner()`, exactly one `app_owner`
  row, a private `documents` bucket with its 4 policies, and the lead rows are
  all present. Output is gitignored — it embeds real CRM rows.

RLS was **not** weakened by any of this: `app_owner` remains `SELECT`-only to
`authenticated` with no grant to `anon`, and ownership is still reachable only
through the privileged dashboard role.

### Evidence (executed, not asserted)

Against a **real PostgreSQL 15** container with the Supabase shim:

- **Negative cases first.** `0004_grant_owner.sql` with 0 auth users → raised
  *"no account exists in auth.users"*, `app_owner` left empty. With 2 auth
  users → raised *"auth.users holds 2 accounts — cannot infer the owner"*,
  `app_owner` still 0 rows. With exactly 1 → granted, then a re-run reported
  *"Ownership already granted (1 row(s))"* and changed nothing.
- **Storage guard both ways.** On a database with no bucket, `0002_storage.sql`
  created it with `public = f` and installed 4 policies. Flipped to public, the
  same file refused: *"bucket "documents" is PUBLIC"*.
- **Single paste on a clean database.** `provision.sql` applied to a fresh
  Postgres (shim + one auth user) and printed *"GapVera provisioned: 9 RLS
  tables, is_owner() present, 1 owner, private documents bucket with 4
  policies, 17 lead(s)."*
- **Idempotent.** The same file run a second time: *"Ownership already
  granted"*, same final notice, counts unchanged — `leads=17 owner=1
  templates=4 buckets=1 storage_policies=4`.
- **RLS intact afterwards.** All **17** assertions in `10-rls-assertions.sql`
  pass against the fully-provisioned database, including *"authenticated
  non-owner sees 0 leads (17 exist)"*, *"owner cannot grant ownership from the
  app role"*, and *"search_path hijack does not grant access"*.
- **Data reconciles.** `pg-readback.mjs` → `reconcile.mjs`: *"RECONCILED — 21
  row(s) across 7 table(s) match the preserved SQLite export"*, `leads`
  checksum `996314deac6df4fc` on both sides.
- **Suite and build green.** `npm test` → 112 passing, 0 failing.
  `npm run build` → clean.

**No new Cloudflare deployment was triggered**, because no client code changed
this pass — the deployed bundle `index-jDw9CGWA.js` is still the correct one.
Triggering a build to produce a new hash would have been theatre.

### What remains — one paste, by Erik

In the already-open SQL editor (GapVera / `main` PRODUCTION):

1. **Authentication → Users → Add user** (email + password) — if his account
   does not exist yet. The SQL refuses rather than guess if it is missing.
2. **Authentication → Providers → Email → "Enable sign ups" OFF.**
3. **SQL editor → paste `migration/export/provision.sql` → Run.** Success
   prints the "GapVera provisioned: …" notice above.

Then login at https://gapvera.pages.dev reaches the Dashboard instead of the
setup screen. No payment card, trial, upgrade, domain, or DNS change at any
step.

**Still not claimed:** the post-login authenticated state has never been
exercised against the production database. It cannot be until the schema
exists, and verifying it afterwards needs Erik's password, which this session
must never request or handle.

## Production incident, 2026-11-06 — root cause and fix

Erik's screenshot showed this on the live login form at
https://gapvera.pages.dev after submitting credentials:

```
Could not find the table 'public.app_owner' in the schema cache
```

**Root cause: the schema migration was never applied to the production
Supabase project.** Measured against the live project, not inferred:

| Probe | Result |
|---|---|
| `/rest/v1/app_owner` | 404 `PGRST205` — table not in schema cache |
| `/rest/v1/leads` | 404 `PGRST205` |
| `/rest/v1/job_runs` | 404 `PGRST205` |
| `/rest/v1/rpc/is_owner` | 404 `PGRST202` — function missing too |
| `/auth/v1/token` (bad password) | 400 `invalid_credentials` — **GoTrue is healthy** |
| `/auth/v1/signup` | rejected — public signup correctly disabled |

So Auth works and the database is empty of schema. A **stale schema cache
was ruled out**: PostgREST emits a *"perhaps you meant"* hint when a similarly
named relation exists, and near-miss probes (`app_owners`, `leadz`) returned
no hint at all. The relations do not exist; the cache is not merely stale.

Applying the migration is a Supabase dashboard action that requires Erik's
login, so **this session could not provision the database** (see "Remaining
blocker"). But the client's *handling* of that state was wrong in three
distinct ways, each a real defect and each fixed in commit `656ceaa`:

1. **A provisioning fault was reported as a login failure.** An unprovisioned
   backend was indistinguishable from a wrong password, so the only action the
   UI offered was retyping a password that was already correct. `PGRST205` and
   `PGRST202` are now detected as their own condition and routed to a new
   `BackendNotProvisionedScreen`. It is checked *before* the not-owner branch,
   because with no `app_owner` table "not the owner" is unknowable rather than
   false. Access still fails closed.
2. **A live token was left behind a login form.** `auth.login()` signs in
   before it verifies ownership, so any throw after sign-in left a valid
   session in `localStorage` while the UI showed a login screen — a reload
   would walk straight back into the broken state holding a token the user
   never knowingly kept. Every post-sign-in failure path now signs out first.
3. **Database internals leaked to a public screen.** Raw PostgREST text naming
   an internal table was rendered to anyone who could load the site.
   human-facing messages no longer carry table names, schema names, or PGRST
   codes; the code is retained on the error object for diagnostics only.

`0001_schema.sql` additionally now ends with a **post-apply verification
block** that raises if any of the 9 tables, `is_owner()`, or RLS on any table
is missing — so a partial apply fails loudly at migration time instead of
silently at first login — followed by `notify pgrst, 'reload schema'`, since a
stale cache and a missing table are indistinguishable at the API (both 404
`PGRST205`).

### Evidence

- **13 new regression tests**, each confirmed **red against the pre-fix code**
  and green after. Suite went 99 → **112 passing, 0 failing**.
  (`client/src/authFlow.test.mjs`, plus 5 cases in `supabase.test.mjs`.)
- **Real Postgres 15**: `0001_schema.sql` applies cleanly and its new
  verification block reports *"GapVera schema verified: 9 tables, is_owner()
  present, RLS enabled on all."*
- **RLS not weakened**: all **17** assertions in `10-rls-assertions.sql` pass
  (exit 0) on shim + schema + storage + data, including both
  privilege-escalation attempts.
- **Real browser, exact reproduction.** `unprovisioned-stub.mjs` reproduces
  production byte-for-byte (GoTrue 200 + session, PostgREST 404 `PGRST205`).
  Submitting the login form now lands on *"GapVera's database isn't set up
  yet."* with: no `app_owner` / `schema cache` / `PGRST` string anywhere in the
  DOM, **no stored session**, no password in `localStorage`, and zero console
  errors.
- **No overcorrection.** Against `provisioned-stub.mjs` (owner row present) the
  same build signs straight through to the Dashboard with owner data visible.
- **Deployed and live-verified.** Commit `656ceaa` is on
  `Scorpionswag/gapvera@main` (confirmed by API readback). It triggered a
  **genuinely new** Pages deployment — `893da117-8a2c-41ac-a484-e3569f4fe322`,
  distinct from the previous `e6bb72bc-…` — check run "Cloudflare Pages"
  completed `success` at 2026-11-07T05:17:09Z. The bundle fetched **from the
  live origin** (`/assets/index-jDw9CGWA.js`, 439362 bytes, sha256
  `a2717037998456e3d2ee888c8f02faa9059f446d93ad8099a274d8bc42327971`) contains
  the new screen copy and the PGRST detection, and contains **no**
  `schema cache` text, no `service_role`, and no JWT literal.

### What is NOT claimed

The production database is **still unprovisioned** — re-probed after the
deployment, `app_owner` still returns 404 `PGRST205`. The fix changes what
Erik *sees* in that state (an honest, actionable setup screen instead of a raw
database error that blamed his password); it does not and cannot create the
schema, because that requires dashboard access that is Erik's alone.

**The post-login screen was not exercised against the production database**,
because doing so needs Erik's password, which this session must never request
or handle. It was exercised in a real browser against a stub returning
production's exact responses, and the shipped bytes serving that code path
were verified from the live origin.

## Current state (2026-11-06): pushed and deployed, one user-only gate left

Resolved this pass:

- **GitHub write access.** The pending collaborator invitation (id
  342008324, `permissions: write`) was accepted by the authenticated user
  `scorpioswaggs`; `repos/Scorpionswag/gapvera` now reports `push: true`,
  where it previously reported READ.
- **Push.** Commit `ef3acf3` is on `Scorpionswag/gapvera@main` — 75 blobs,
  confirmed by API readback. No `.env`, no `crm.db`, and no
  `migration/export/` reached the remote.
- **Cloudflare Pages deployment.** The push auto-triggered the existing Pages
  project `gapvera`. The GitHub check run "Cloudflare Pages" (app:
  *Cloudflare Workers and Pages*) completed `success` at
  2026-11-06T21:59:13Z — deployment
  `e6bb72bc-c30a-4ea2-bc8e-b62641a1d551`, account
  `731d919f8e647c79f9a3a6bfc5dbf15d`.
- **Live URL: https://gapvera.pages.dev** — HTTP 200, served by Cloudflare
  (`cf-ray` present), independent of Erik's computer.
- **Shipped-bundle identity confirmed.** `/assets/index-DqmqpBo1.js` fetched
  from the live origin is **437289 bytes, sha256
  `ffd3c9b206cf7e031c68ca328d49e3c45fec979b55273d590c7e9653fc4a6ff7`** —
  byte-identical to the locally built artifact. What was tested is what is
  live.
- **Live bundle secret scan** (against the deployed file, not a local copy):
  no JWT, no `service_role`, no `localhost`, no `127.0.0.1`, no LAN address,
  no `<ref>.supabase.co`, no stale `/api/` path.
- **SPA deep links work.** `/territory` returns 200 and serves the index
  shell, so `client/public/_redirects` is in effect.

## Remaining blocker (user-only)

**Superseded as of 2026-11-07.** `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` **are now set** in the Cloudflare Pages project —
verified from the live bundle, which contains
`https://iwmdfapdzyqfzhdgzdpa.supabase.co` and an `sb_publishable_…` key (the
correct publishable key kind, not a JWT and not `service_role`). The site no
longer shows the CONFIGURATION MISSING card; it reaches the real login form.

**The one remaining gate is the Supabase dashboard setup**, which is why
login fails: the schema migration has never been run against the project, so
every table returns 404 `PGRST205` (see "Production incident" above).

### What Erik needs to do (all free, all dashboard)

In the Supabase dashboard for project `iwmdfapdzyqfzhdgzdpa`, follow
`supabase/README.md` steps 2–8:

1. **SQL editor → paste and run `supabase/migrations/0001_schema.sql`.** It
   now self-verifies and will raise if the apply is incomplete. On success it
   prints *"GapVera schema verified: 9 tables, is_owner() present, RLS enabled
   on all."*
2. **Authentication → Users → Add user** (email + password). Not a signup form.
3. **Authentication → Providers → Email → "Enable sign ups" OFF.**
4. **SQL editor → grant ownership** (README step 5) — without this row every
   table correctly returns zero rows.
5. **Storage → New bucket `documents`, Public OFF**, then run
   `0002_storage.sql` (it refuses to apply to a public bucket).
6. **Import** `migration/export/data.sql`, then reconcile per README step 7.

No payment card, trial, upgrade, domain, or DNS change is involved at any
step. Once step 1 and step 4 are done, the login that currently lands on the
setup screen will reach the Dashboard.

## Previous blocker, now resolved (recorded 2026-11-06)

**`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are not set in the
Cloudflare Pages project, so the deployed build fails closed.**

The live site renders the product's own CONFIGURATION MISSING card — *"This
build is not connected to a backend."* That is the designed fail-closed
behaviour the spec requires, not a crash and not a fake success. But it means
no auth, CRM, document, or map surface can be exercised on the hosted
product, so criteria 3–6, 8–10 and 12 cannot be closed as live-verified.

These are **build-time** values: Vite inlines them at compile time, so setting
them requires a new deployment, not a reload.

Why this session could not set them — verified, not assumed:

- Hermes credential vault: empty (no Cloudflare, no Supabase item).
- No `wrangler`/`supabase` CLI; `~/.wrangler`, `~/.config/wrangler`,
  `~/.supabase`, `~/.config/supabase`, `~/.netrc`: all absent.
- No `CLOUDFLARE_*`, `CF_*`, `SUPABASE_*`, or `VITE_*` variables in the
  environment.
- `dash.cloudflare.com` serves a Turnstile "Verify you are human" challenge
  to this browser session and does not clear it; past it, the dashboard still
  needs Erik's Cloudflare login, which is his alone to supply.

The Supabase project is reachable and correctly refuses anonymous callers:
`iwmdfapdzyqfzhdgzdpa.supabase.co/rest/v1/` and `/auth/v1/health` both return
HTTP 401 `No API key found`. The project exists; this session holds no key.

### What Erik needs to do (two dashboard steps, both free)

1. Cloudflare → Pages → `gapvera` → Settings → Environment variables. Add
   `VITE_SUPABASE_URL` (`https://iwmdfapdzyqfzhdgzdpa.supabase.co`) and
   `VITE_SUPABASE_ANON_KEY` (Supabase → Settings → API → `anon`/publishable
   key) for Production *and* Preview. Confirm build command `npm run build`,
   output directory `client/dist`. Then Deployments → Retry deployment.
2. The Supabase dashboard steps in `supabase/README.md`: run the three
   migrations, create Erik's user, turn **Enable sign ups OFF**, insert the
   `app_owner` row, create the private `documents` bucket, import
   `migration/export/data.sql`, then re-run `migration/reconcile.mjs`
   against the real project.

Neither step involves a payment card, trial, upgrade, domain, or DNS change.
The `anon` key is safe in the Pages build — RLS, not that key's secrecy, is
what protects the data (`supabase/README.md`, "Keys: which is which"). The
`service_role` key must never go there.

Once both are done, the hosted dogfood pass of criterion 12 can run.

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
| 1 | Pages serves frontend at public HTTPS while computer off | **Deployed and live-verified.** https://gapvera.pages.dev returns 200 from Cloudflare's edge (`cf-ray` present, `server: cloudflare`), independent of Erik's machine. SPA `_redirects` verified live (`/territory` → 200, index shell). The app itself is not yet backend-connected — see criterion 3 onward. |
| 2 | No paid plan, trial, card, or purchased domain | **Held** — nothing was signed up for or purchased. Zero spend. The CARTO basemap, which now needs a paid key, was replaced rather than paid for (criterion 9). |
| 3 | Supabase Auth; signup disabled; anon blocked from CRM | **Implemented + locally verified.** Against real Postgres: `anon` is refused on `leads` and `documents` at the privilege layer, cannot insert, and an authenticated non-owner sees 0 of 17 leads. The UI states that public signup is disabled and offers no register form. The dashboard toggle that enforces it server-side still needs the account (`supabase/README.md` step 4). |
| 4 | Verified migrated copy reconciles against SQLite export | **Implemented + locally verified end-to-end.** `data.sql` was imported into a real Postgres 15, every table read back out as CSV, and `reconcile.mjs` matched all 7 per-table checksums and all foreign keys: *"RECONCILED — 21 row(s) across 7 table(s) match the preserved SQLite export."* |
| 5 | CRM CRUD from a phone on cellular | **Implemented + locally verified; not deployed.** A full create → read → update → delete round-trip ran from the browser against real Postgres, leaving the 17 migrated leads intact. Mobile layout verified at 390 px (below). Cellular itself needs a deployment. |
| 6 | Documents in private Storage, signed access only | **Implemented + locally verified (SQL).** `0002_storage.sql` *refuses to apply* against a public bucket — tested both ways: it aborted on a public bucket and applied cleanly on a private one. `DocLink.jsx` mints a signed URL per click, because a private bucket has no durable `href`. |
| 7 | No localhost/LAN/secret/service-role key in bundle | **Live-verified on the deployed bundle.** The file served from https://gapvera.pages.dev (sha256 `ffd3c9b2…6ff7`, byte-identical to the local build) contains no JWT, no `service_role`, no credential, no `localhost`/`127.0.0.1`/LAN match, no `<ref>.supabase.co`, and no stale `/api/` path. |
| 8 | Logout, expiry, direct API/Storage calls fail closed | **Implemented + locally verified.** Four paths each returned 401: tampered token, no token, direct Storage sign with no token, and a token reused after logout. On reload with a revoked token the app shows "Your session expired", clears the stored session, and leaks no lead data into the DOM. |
| 9 | Map renders with attribution, no exposed credential | **Fixed this session + locally verified.** CARTO was silently broken (see below); the map now uses OpenStreetMap with required attribution and no credential at all. |
| 10 | Durable job records; retries don't duplicate mutations | **Implemented + locally verified (SQL).** The unique index on `(job, idempotency_key)` was exercised against real Postgres: a duplicate claim for the same period is rejected, a new period still claims. A cross-day duplicate-draft bug in the Edge Function was found and fixed (see below). Not deployed, so not live-verified. |
| 11 | Scraping/SMTP visibly unavailable, no fake success | **Implemented + locally verified.** The Scrape page shows an UNAVAILABLE badge, explains why, and offers CSV import — no dead search box. The Outreach composer says "DRAFTS ONLY — SENDING IS UNAVAILABLE" and offers *Save draft* / *Copy for sending*. Verified in the database: saving a draft writes `status='draft'` and leaves `outreach_status` and `last_contact_date` untouched, so nothing claims a send that did not happen. Email discovery and site auditing are likewise marked unavailable rather than stubbed. |
| 12 | Hosted desktop + mobile dogfood passes | **Hosted shell verified; full pass still blocked.** The hosted site loads, fonts resolve, there is zero horizontal overflow at desktop width, and deep links resolve. But with no `VITE_SUPABASE_*` set the build fails closed at the configuration screen, so auth, CRM navigation, lead records, documents and the map cannot be exercised on the hosted product. All 9 routes passed this pass locally at desktop and 390 px with zero overflow. **Not closed.** |
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

See "What Erik needs to do" at the top of this document. In short: set the two
`VITE_SUPABASE_*` variables in the Cloudflare Pages project and retry the
deployment, then complete the Supabase dashboard steps in
`supabase/README.md`. Both are free-tier dashboard actions.

GitHub access and the Pages deployment are no longer blockers — they were
resolved in this pass.

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
