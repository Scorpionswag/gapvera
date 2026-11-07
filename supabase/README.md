# GapVera zero-cost provider setup

Everything in this directory is provider configuration for the approved
zero-cost migration (`handoff/zero-cost/`). Nothing here has been applied to a
live project — see `migration/STATUS.md` for exactly what is and is not done.

**Cost boundary: every step below is on a free tier. Do not enter a payment
card, start a trial, or accept an upgrade prompt at any point.** If a step asks
for billing, stop; it means the plan drifted and the decision needs revisiting.

## Order of operations

1. **Create the Supabase project** (Free plan). Region closest to Miami.
2. **Run the schema**: paste `supabase/migrations/0001_schema.sql` into the
   Supabase SQL editor and execute it. This creates the CRM tables, the
   `job_runs` ledger, and owner-only RLS on everything.
3. **Create Erik's user**: Authentication → Users → "Add user" → create with
   email + password. Do *not* use a public signup form.
4. **Disable public signup**: Authentication → Providers → Email → turn
   **"Enable sign ups"** OFF. Leave email/password sign-in ON. This is
   acceptance criterion 3 and it is a dashboard setting, not code — code cannot
   enforce it.
5. **Grant ownership** — the one step that turns a logged-in user into the
   owner. In the SQL editor:

   ```sql
   insert into public.app_owner (user_id, email)
   select id, email from auth.users where email = 'ERIK_EMAIL_HERE';
   ```

   Until this row exists, every table correctly returns zero rows: `is_owner()`
   is false, so RLS denies everything. That is the intended fail-closed state.

   > **Step 2 is not optional, and skipping it looks like a login bug.**
   > On 2026-11-06 the live site reported
   > `Could not find the table 'public.app_owner' in the schema cache`
   > on the login form because the project had Auth configured but the schema
   > migration had never been run. Sign-in succeeded; there was simply no
   > database behind it. `0001_schema.sql` now ends with a verification block
   > that raises if any of the 9 tables, `is_owner()`, or RLS is missing, and
   > issues `notify pgrst, 'reload schema'` so PostgREST re-reads the schema
   > instead of serving a stale cache. If that block raises, re-run the whole
   > file — do not proceed to step 3.

6. **Import the data**: run `supabase/migrations/0001_schema.sql` first, then
   paste `migration/export/data.sql`. Generate it with:

   ```sh
   node migration/export-sqlite.mjs ~/gapvera/server/crm.db migration/export
   ```

7. **Verify the import** (acceptance 4). In the SQL editor, run one query per
   table using the column order from `migration/export/manifest.json`, download
   each as CSV into a directory, then:

   ```sh
   node migration/reconcile.mjs migration/export /path/to/downloaded-csvs
   ```

   It exits non-zero on any mismatch in row counts, ids, relationships, or
   cell content. Do not proceed on a failure.

8. **Create the documents bucket**: Storage → New bucket → name `documents` →
   **Public: OFF**. Then apply the storage policies in
   `supabase/migrations/0002_storage.sql`.

9. **Deploy the Edge Function** (follow-up sweep, drafts only — no sending):

   ```sh
   supabase functions deploy followup-sweep
   ```

10. **Schedule it** with Supabase Cron (`pg_cron`), daily. See
    `0003_cron.sql`.

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
