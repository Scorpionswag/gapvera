-- RLS enforcement proof for the GapVera hosted schema.
--
-- Acceptance criteria 3 and 8: anonymous users cannot reach CRM data, and
-- direct API calls fail closed. Those are claims about Postgres behaviour, so
-- they are tested by actually impersonating the roles PostgREST uses rather
-- than by reading the policy text.
--
-- Run against a database that already has the shim + 0001 + 0002 + data
-- applied. Every block below RAISEs on the wrong outcome, so a silent pass is
-- not possible: the script either prints its assertions or aborts.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. anon sees nothing, even though 17 leads exist
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  -- The privilege layer should refuse before RLS is even consulted, because
  -- 0001_schema.sql revoked all grants from anon.
  begin
    set local role anon;
    execute 'select count(*) from public.leads' into n;
    reset role;
    raise exception 'FAIL: anon was able to read leads (got % rows)', n;
  exception
    when insufficient_privilege then
      reset role;
      raise notice 'PASS: anon is refused on leads at the privilege layer';
  end;
end $$;

do $$
declare
  n integer;
begin
  begin
    set local role anon;
    execute 'select count(*) from public.documents' into n;
    reset role;
    raise exception 'FAIL: anon was able to read documents';
  exception
    when insufficient_privilege then
      reset role;
      raise notice 'PASS: anon is refused on documents';
  end;
end $$;

do $$
begin
  begin
    set local role anon;
    execute 'insert into public.leads (business_name) values (''anon injected'')';
    reset role;
    raise exception 'FAIL: anon was able to INSERT a lead';
  exception
    when insufficient_privilege then
      reset role;
      raise notice 'PASS: anon cannot insert';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2. authenticated but NOT the owner: app_owner is empty, so nothing is visible
-- ---------------------------------------------------------------------------
-- This is the fail-closed posture of a freshly migrated project: the data is
-- all there, but until someone is granted ownership, every query returns zero.
do $$
declare
  n integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into n from public.leads;
  reset role;
  if n <> 0 then
    raise exception 'FAIL: non-owner saw % lead(s); expected 0', n;
  end if;
  raise notice 'PASS: authenticated non-owner sees 0 leads (17 exist)';
end $$;

do $$
declare
  n integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into n from public.email_templates;
  reset role;
  if n <> 0 then
    raise exception 'FAIL: non-owner saw % template(s); expected 0', n;
  end if;
  raise notice 'PASS: authenticated non-owner sees 0 email_templates (4 exist)';
end $$;

-- A non-owner must not be able to write either — with check() has to deny the
-- insert, not just hide the row afterwards.
do $$
begin
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
    insert into public.leads (business_name) values ('non-owner injected');
    reset role;
    raise exception 'FAIL: non-owner was able to INSERT a lead';
  exception
    when insufficient_privilege then
      reset role;
      raise notice 'PASS: non-owner insert denied by RLS with check()';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. the owner sees everything
-- ---------------------------------------------------------------------------
-- Grant ownership the way supabase/README.md step 5 describes, then confirm
-- the same queries that returned 0 now return the real data.
insert into auth.users (id, email)
values ('22222222-2222-2222-2222-222222222222', 'erik@example.com');

insert into public.app_owner (user_id, email)
select id, email from auth.users where email = 'erik@example.com';

do $$
declare
  n integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select count(*) into n from public.leads;
  reset role;
  if n <> 17 then
    raise exception 'FAIL: owner saw % lead(s); expected 17', n;
  end if;
  raise notice 'PASS: owner sees all 17 leads';
end $$;

do $$
declare
  score integer;
  name  text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  select business_name, lead_score into name, score from public.leads where id = 1;
  reset role;
  if name is null then
    raise exception 'FAIL: owner could not read lead 1';
  end if;
  raise notice 'PASS: owner reads lead 1 = % (score %)', name, score;
end $$;

-- The owner can write. This is the CRUD path the hosted app depends on.
do $$
declare
  new_id bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  insert into public.leads (business_name, location)
    values ('RLS Test Co', 'Miami, FL') returning id into new_id;
  update public.leads set phone = '305-555-9999' where id = new_id;
  delete from public.leads where id = new_id;
  reset role;
  raise notice 'PASS: owner can insert, update, and delete (round-tripped id %)', new_id;
end $$;

-- ---------------------------------------------------------------------------
-- 4. the owner must NOT be able to promote anyone (including themselves)
-- ---------------------------------------------------------------------------
-- app_owner has a select-only policy. If the app could write it, a compromised
-- anon key plus any signup would be a full privilege escalation.
do $$
begin
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
    insert into public.app_owner (user_id, email)
      values ('33333333-3333-3333-3333-333333333333', 'attacker@example.com');
    reset role;
    raise exception 'FAIL: an authenticated user granted ownership to another account';
  exception
    when insufficient_privilege then
      reset role;
      raise notice 'PASS: owner cannot grant ownership from the app role';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. job_runs idempotency (acceptance 10)
-- ---------------------------------------------------------------------------
-- The unique index is what makes an at-least-once scheduler safe. A second
-- claim for the same period must fail, which is the 409 the Edge Function
-- treats as "already ran".
do $$
begin
  insert into public.job_runs (job, idempotency_key) values ('followup-sweep', '2026-11-06');
  begin
    insert into public.job_runs (job, idempotency_key) values ('followup-sweep', '2026-11-06');
    raise exception 'FAIL: a duplicate job claim for the same period succeeded';
  exception
    when unique_violation then
      raise notice 'PASS: duplicate job claim rejected by the unique index';
  end;
  -- A different period is a legitimately new run.
  insert into public.job_runs (job, idempotency_key) values ('followup-sweep', '2026-11-07');
  raise notice 'PASS: a new period can still claim a run';
end $$;

-- ---------------------------------------------------------------------------
-- 6. storage: anon cannot read objects in the private bucket
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  begin
    set local role anon;
    execute 'select count(*) from storage.objects where bucket_id = ''documents''' into n;
    reset role;
    -- anon holds a select grant on storage.objects in real Supabase, so the
    -- defence here is RLS: no policy grants anon anything, so the result set
    -- must be empty rather than an error.
    if n <> 0 then
      raise exception 'FAIL: anon saw % storage object(s)', n;
    end if;
    raise notice 'PASS: anon sees 0 objects in the private documents bucket';
  exception
    when insufficient_privilege then
      reset role;
      raise notice 'PASS: anon is refused on storage.objects outright';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 7. forced RLS: even the table owner cannot bypass the policies
-- ---------------------------------------------------------------------------
-- "force row level security" is why this holds. Without it, the table owner
-- role silently bypasses RLS and a misconfigured connection would see
-- everything.
do $$
declare
  forced boolean;
  enabled boolean;
  t text;
begin
  for t in select unnest(array['leads','clients','calls','email_templates',
                              'email_logs','documents','invoices','job_runs'])
  loop
    select relrowsecurity, relforcerowsecurity into enabled, forced
      from pg_class where oid = ('public.' || t)::regclass;
    if not enabled then
      raise exception 'FAIL: RLS is not enabled on %', t;
    end if;
    if not forced then
      raise exception 'FAIL: RLS is not FORCED on %', t;
    end if;
  end loop;
  raise notice 'PASS: RLS is enabled AND forced on all 8 CRM tables';
end $$;

-- ---------------------------------------------------------------------------
-- 8. is_owner() cannot be hijacked through search_path
-- ---------------------------------------------------------------------------
-- A SECURITY DEFINER function with a caller-controlled search_path is a
-- privilege-escalation primitive: the caller creates their own app_owner table
-- in a schema that resolves first. The pinned search_path is what stops it.
do $$
declare
  cfg text[];
begin
  select proconfig into cfg from pg_proc
   where oid = 'public.is_owner()'::regprocedure;
  if cfg is null or not (cfg @> array['search_path=public, pg_catalog']) then
    raise exception 'FAIL: is_owner() does not pin search_path (proconfig=%)', cfg;
  end if;
  raise notice 'PASS: is_owner() pins search_path';
end $$;

-- Prove it behaviourally as well as structurally.
create schema if not exists hijack;
create table hijack.app_owner (user_id uuid, email text);
insert into hijack.app_owner values ('44444444-4444-4444-4444-444444444444', 'attacker@example.com');
grant usage on schema hijack to authenticated;
grant select on hijack.app_owner to authenticated;

do $$
declare
  n integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
  -- Try to make the attacker's own table resolve first.
  perform set_config('search_path', 'hijack, public', true);
  select count(*) into n from public.leads;
  reset role;
  if n <> 0 then
    raise exception 'FAIL: search_path hijack granted access to % lead(s)', n;
  end if;
  raise notice 'PASS: search_path hijack does not grant access';
end $$;

select 'ALL RLS ASSERTIONS PASSED' as result;
