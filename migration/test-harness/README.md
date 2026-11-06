# Local verification harness

Nothing in here ships. These scripts exist so the migration could be verified
against a **real** PostgreSQL and a **real** browser on a machine with no
Supabase credentials and no Cloudflare account.

They are not a Supabase emulator. See "What this proves" at the bottom.

## Why

Reading SQL and concluding it is correct is not verification. Three of the
acceptance criteria (3, 4, 8) are claims about what Postgres *does* when an
anonymous or non-owner role issues a query, and criteria 5/11/12 are claims
about what the UI *shows*. Both demand execution.

## Prerequisites

Docker. On macOS with Colima:

```sh
colima start --cpu 2 --memory 2 --disk 10
```

## 1. Bring up Postgres and apply the migrations

```sh
docker run -d --name gapvera-sqltest \
  -e POSTGRES_PASSWORD=testpw -e POSTGRES_DB=gapvera \
  -p 55432:5432 postgres:15-alpine

run() { docker cp "$1" gapvera-sqltest:/tmp/x.sql >/dev/null &&
        docker exec gapvera-sqltest psql -U postgres -d gapvera -v ON_ERROR_STOP=1 -f /tmp/x.sql; }

run migration/test-harness/00-supabase-shim.sql
run supabase/migrations/0001_schema.sql

# 0002 operates on a bucket that Supabase's dashboard normally creates. The
# shim does not invent one, because 0002's first job is to refuse when the
# bucket is missing or public. Create a PRIVATE one, then apply:
docker exec gapvera-sqltest psql -U postgres -d gapvera -c \
  "insert into storage.buckets (id, name, public) values ('documents','documents',false);"

run supabase/migrations/0002_storage.sql
run migration/export/data.sql
```

`00-supabase-shim.sql` supplies what Supabase provides and a bare Postgres does
not: the `auth` and `storage` schemas, `auth.uid()` reading the JWT claim out
of `request.jwt.claim.sub`, and the `anon` / `authenticated` roles. The real
migrations are run **unmodified**.

`0002_storage.sql` is a guard as much as a migration. Both refusals are worth
seeing, since acceptance criterion 6 depends on them:

```
-- no bucket at all:
ERROR:  bucket "documents" does not exist — create it first (Storage -> New bucket)
-- bucket exists but is public:
ERROR:  bucket "documents" is PUBLIC — set it to private before applying these policies
```

## 2. Prove the RLS policies (criteria 3, 8, 10)

```sh
run migration/test-harness/10-rls-assertions.sql
```

16 assertions. Each one `RAISE`s an exception on the wrong outcome, so a silent
pass is impossible — the script either prints its `PASS` notices or aborts.

They impersonate the roles PostgREST actually uses (`set local role anon` /
`authenticated` plus a JWT claim) rather than inspecting policy text. Covered:
anon is refused outright; an authenticated non-owner sees 0 of 17 leads; the
owner sees all 17 and can round-trip a write; the owner **cannot** grant
ownership to anyone; a `search_path` hijack does not grant access; RLS is
enabled *and forced* on all 8 tables; duplicate job claims are rejected.

## 3. Prove the data migrated intact (criterion 4)

```sh
node migration/test-harness/pg-readback.mjs gapvera-sqltest gapvera /tmp/gv-pg-readback
node migration/reconcile.mjs migration/export /tmp/gv-pg-readback
```

The readback reads every table **out of Postgres** in the column order the
SQLite export recorded. Comparing the manifest to itself would prove nothing;
the CSV has to come from the destination database.

Expect: `RECONCILED — 21 row(s) across 7 table(s)`, with per-table checksums
matching the SQLite side.

## 4. Drive the real UI (criteria 5, 11, 12)

```sh
node migration/test-harness/mock-supabase.mjs 54321          # terminal 1

VITE_SUPABASE_URL=http://127.0.0.1:54321 \
VITE_SUPABASE_ANON_KEY=dogfood-anon-key npm run build        # terminal 2
node migration/test-harness/serve-spa.mjs client/dist 8899
```

Open <http://127.0.0.1:8899/> and sign in as `erik@example.com` with the
password `mock-supabase.mjs` prints at startup. The app runs **unmodified**
against real Postgres holding the real migrated rows.

`serve-spa.mjs` rather than `python3 -m http.server`: the app uses
`BrowserRouter`, so `/outreach` is a real path. Production handles this through
`client/public/_redirects`; a plain static server 404s and renders a blank
page, which looks like an app bug and is not one.

`build-debug.sh` produces an unminified, sourcemapped build when you need a
readable stack trace. A minified build reports React errors with an empty
message, which is how a `ReferenceError` once survived a dogfood pass.

## Teardown

```sh
docker rm -f gapvera-sqltest
```

Nothing here touches `server/crm.db`. The source SQLite is read-only
throughout, and its SHA-256 is recorded in `migration/STATUS.md`.

## What this proves — and what it does not

**Proves:** the migration SQL is valid and applies cleanly; the RLS policies
deny and allow the right things under the right roles; the exported data lands
in Postgres byte-for-byte; the client's request shapes, data flow, and UI
states are correct.

**Does not prove:** anything about Supabase's hosted behaviour. In particular
`mock-supabase.mjs` connects as a superuser and **does not enforce RLS** — it
exists to exercise the UI, and the RLS claims rest entirely on
`10-rls-assertions.sql`. Acceptance criterion 12's gate still requires a
dogfood pass on the real hosted product.
