# GapVera zero-cost provider setup

Everything in this directory is provider configuration for the approved
zero-cost migration (`handoff/zero-cost/`). Nothing here has been applied to a
live project — see `migration/STATUS.md` for exactly what is and is not done.

**Cost boundary: every step below is on a free tier. Do not enter a payment
card, start a trial, or accept an upgrade prompt at any point.** If a step asks
for billing, stop; it means the plan drifted and the decision needs revisiting.

## Order of operations

**The SQL is now one paste.** Build it once:

```sh
node migration/export-sqlite.mjs server/crm.db migration/export   # if data.sql is absent
node supabase/build-provision-sql.mjs                             # -> migration/export/provision.sql
```

`provision.sql` concatenates `0001_schema.sql`, `0002_storage.sql`,
`0004_grant_owner.sql` and `data.sql` in the only order that works, and ends
with a verification block that raises unless all 9 RLS tables, `is_owner()`,
exactly one `app_owner` row, a **private** `documents` bucket and its 4
policies, and the lead rows are all present. It is idempotent — running it
twice changes nothing the second time. It is gitignored because it embeds real
CRM rows; do not paste it into a shared channel.

1. **Create the Supabase project** (Free plan). Region closest to Miami.
2. **Create Erik's user**: Authentication → Users → "Add user" → email +
   password. Do *not* use a public signup form. Do this **before** the SQL:
   the ownership section resolves the account from `auth.users` rather than
   taking a typed-in email, and refuses rather than guess if there are zero or
   more than one.
3. **Disable public signup**: Authentication → Providers → Email → turn
   **"Enable sign ups"** OFF. Leave email/password sign-in ON. This is
   acceptance criterion 3 and it is a dashboard setting, not code — code cannot
   enforce it.
4. **SQL editor → paste `migration/export/provision.sql` → Run.** On success
   it prints *"GapVera provisioned: 9 RLS tables, is_owner() present, 1 owner,
   private documents bucket with 4 policies, 17 lead(s)."* Anything else is a
   failure; read the raised message and do not proceed.
5. **Verify the import** (acceptance 4) — see "Reconciling the import" below.
6. **Deploy the Edge Function** (follow-up sweep, drafts only — no sending):

   ```sh
   supabase functions deploy followup-sweep
   ```

7. **Schedule it** with Supabase Cron (`pg_cron`), daily. See `0003_cron.sql`.

### What each section of the paste does

| Source | Effect |
|---|---|
| `0001_schema.sql` | 9 CRM tables, the `job_runs` ledger, `is_owner()`, owner-only RLS forced on everything. Self-verifies. |
| `0002_storage.sql` | Creates the `documents` bucket **private** if absent, then owner-only policies on all four verbs. Still refuses outright if the bucket already exists and is public. |
| `0004_grant_owner.sql` | Binds the single `auth.users` account to `app_owner`. Until this row exists `is_owner()` is false and every table correctly returns zero rows — the intended fail-closed state. |
| `data.sql` | The verified CRM copy, id-preserving, `ON CONFLICT DO NOTHING` in one transaction. |

> **Skipping the schema looks like a login bug.** On 2026-11-06 the live site
> reported `Could not find the table 'public.app_owner' in the schema cache` on
> the login form because the project had Auth configured but the migration had
> never been run. Sign-in succeeded; there was simply no database behind it.
> That is the ordering mistake the single paste exists to make impossible.

### Granting ownership to a specific account

`0004_grant_owner.sql` deliberately refuses when `auth.users` holds more than
one account rather than picking one — guessing would hand sole ownership of
the CRM to whichever row sorted first. If that happens, grant explicitly by
uuid (Authentication → Users shows it), which also keeps the address out of
the query and out of the result grid:

```sql
insert into public.app_owner (user_id, email)
select id, email from auth.users where id = '<the-uuid>';
```

### Reconciling the import

In the SQL editor, run one query per table using the column order from
`migration/export/manifest.json`, download each as CSV into a directory, then:

```sh
node migration/reconcile.mjs migration/export /path/to/downloaded-csvs
```

It exits non-zero on any mismatch in row counts, ids, relationships, or cell
content. Do not proceed on a failure.

## Keys: which is which

| Key | Where it belongs | Notes |
|---|---|---|
| `anon` / publishable | Browser, `VITE_SUPABASE_ANON_KEY` | Safe to ship. RLS is what protects data, not this key's secrecy. |
| `service_role` | Edge Function env ONLY | Bypasses RLS entirely. Never in the client, never in git, never in a handoff. |

The frontend build takes exactly two variables:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

Set them in Cloudflare Pages → Settings → Environment variables. `.env` files
are gitignored; `.env.example` documents the names only.

## Cloudflare Pages

- Framework preset: none. **Build command:** `npm run build`.
  **Output directory:** `client/dist`.
- Add the two `VITE_` variables above for both Production and Preview.
- Add `client/public/_redirects` (already in the repo) so client-side routes
  deep-link correctly instead of 404ing.
- Free plan only. No Workers paid tier, no custom domain purchase — the
  `*.pages.dev` hostname provides public HTTPS at no cost.

## What is deliberately not here

- **Google Places scraping**: disabled in the baseline (no compliant no-cost
  path verified). The Scrape page must show it as unavailable and route to
  manual entry / CSV import.
- **Automated SMTP**: disabled. The sweep stages drafts; Erik sends manually.
- Neither is faked. Acceptance criterion 11 forbids showing a fake success.
