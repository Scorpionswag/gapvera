#!/usr/bin/env node
// Build a single paste-once provisioning script for the Supabase SQL editor.
//
// Why this exists: provisioning was six separate editor pastes in a required
// order, and a skipped or half-pasted step produces a project that looks
// migrated and 404s on first login — the exact 2026-11-06 production failure.
// One file in one transaction-per-section removes the ordering mistake.
//
// The output contains real CRM rows, so it is written into migration/export/,
// which is gitignored. It is never committed and never printed.
//
//   node supabase/build-provision-sql.mjs
//   -> migration/export/provision.sql

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Order is the contract: schema before storage policies (they call
// is_owner()), owner grant before data is useful, data last so a failed
// import cannot leave the gate unbuilt.
const parts = [
  ['supabase/migrations/0001_schema.sql', 'SCHEMA — tables, is_owner(), owner-only RLS'],
  ['supabase/migrations/0002_storage.sql', 'STORAGE — private documents bucket + owner-only policies'],
  ['supabase/migrations/0004_grant_owner.sql', 'OWNERSHIP — bind the single auth account to app_owner'],
  ['migration/export/data.sql', 'DATA — verified CRM copy, id-preserving, ON CONFLICT DO NOTHING'],
];

const missing = parts.map(([p]) => p).filter((p) => !existsSync(join(root, p)));
if (missing.length) {
  console.error('missing input file(s):\n  ' + missing.join('\n  '));
  if (missing.includes('migration/export/data.sql')) {
    console.error('\nGenerate it first:\n  node migration/export-sqlite.mjs server/crm.db migration/export');
  }
  process.exit(1);
}

const header = `-- GapVera production provisioning — generated, do not edit by hand.
-- Source: supabase/build-provision-sql.mjs
--
-- Paste this whole file into the Supabase SQL editor and Run, ONCE, AFTER:
--   1. Authentication -> Users -> Add user  (Erik's account must already exist;
--      the ownership section below refuses rather than guess if it does not)
--   2. Authentication -> Providers -> Email -> "Enable sign ups" OFF
--
-- Every section is idempotent: re-running makes no second change.
-- Every section self-verifies and RAISES rather than half-applying.
--
-- CONTAINS REAL CRM DATA. Gitignored. Do not paste into a shared channel.
`;

let out = header;
for (const [rel, label] of parts) {
  const body = readFileSync(join(root, rel), 'utf8');
  out +=
    `\n\n-- ${'='.repeat(74)}\n-- ${label}\n-- source: ${rel}\n-- ${'='.repeat(74)}\n\n` +
    body.trimEnd() +
    '\n';
}

out += `

-- ============================================================================
-- FINAL VERIFICATION — everything the client needs, checked in one place
-- ============================================================================

do $$
declare
  n_tables  integer;
  n_owner   integer;
  n_leads   integer;
  n_pol     integer;
  bucket_ok boolean;
begin
  select count(*) into n_tables
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and c.relname in ('app_owner','leads','clients','calls',
                        'email_templates','email_logs','documents','invoices','job_runs');
  if n_tables <> 9 then
    raise exception 'expected 9 RLS-enabled tables, found %', n_tables;
  end if;

  if to_regprocedure('public.is_owner()') is null then
    raise exception 'public.is_owner() is missing';
  end if;

  select count(*) into n_owner from public.app_owner;
  if n_owner <> 1 then
    raise exception 'expected exactly 1 app_owner row, found %', n_owner;
  end if;

  select (not public) into bucket_ok from storage.buckets where id = 'documents';
  if bucket_ok is not true then
    raise exception 'documents bucket is missing or public';
  end if;

  select count(*) into n_pol from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'documents_owner_%';
  if n_pol <> 4 then
    raise exception 'expected 4 documents storage policies, found %', n_pol;
  end if;

  select count(*) into n_leads from public.leads;

  raise notice 'GapVera provisioned: 9 RLS tables, is_owner() present, 1 owner, private documents bucket with 4 policies, % lead(s).', n_leads;
end $$;

notify pgrst, 'reload schema';
`;

const dest = join(root, 'migration/export/provision.sql');
writeFileSync(dest, out);
console.log(`wrote ${dest}`);
console.log(`${out.length} bytes, ${parts.length} section(s) + final verification`);
console.log('gitignored (migration/export/) — contains real CRM rows');
