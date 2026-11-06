-- Supabase-compatible shim for executing the GapVera migrations against a
-- plain Postgres container.
--
-- This is a TEST HARNESS, not part of the deployment. Supabase provides these
-- objects already; a bare postgres:15 image does not, so without them
-- 0001_schema.sql fails on its first foreign key and nothing downstream gets
-- exercised. The point is to execute the real migration files unmodified.
--
-- What is faithfully reproduced:
--   * roles anon / authenticated / service_role (Supabase's API roles)
--   * auth.users with a uuid primary key (the FK target for app_owner)
--   * auth.uid() reading request.jwt.claim.sub, which is how Supabase's
--     PostgREST passes the authenticated user down to RLS policies
--   * storage.buckets and storage.objects with RLS enabled on objects
--
-- What is NOT reproduced: GoTrue, PostgREST's role switching, JWT validation.
-- Those are exercised by impersonating a role with SET ROLE, which is exactly
-- what PostgREST does per request.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- postgres must be able to assume these to simulate a request.
grant anon, authenticated, service_role to postgres;

create schema if not exists auth;
create schema if not exists storage;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;

create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique not null
);

-- Supabase's auth.uid() reads the sub claim out of the request JWT. Returning
-- NULL when unset is the important behaviour: that is the anonymous case, and
-- it is what makes is_owner() false and every policy deny.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table storage.buckets (
  id     text primary key,
  name   text not null,
  public boolean not null default false
);

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text not null,
  owner      uuid,
  created_at timestamptz default now()
);

-- Supabase ships storage.objects with RLS already enabled; 0002_storage.sql
-- assumes that and only adds policies.
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated, anon;
