-- GapVera ownership grant.
--
-- Run AFTER 0001_schema.sql, and AFTER Erik's user exists in
-- Authentication -> Users. This is the one step that turns a signed-in user
-- into the owner: until an app_owner row exists, is_owner() is false and every
-- RLS policy correctly denies, so the app signs in and then shows nothing.
--
-- Replaces the hand-edited snippet in supabase/README.md step 5, which
-- required pasting a literal email address into the SQL editor. This file
-- resolves the account from auth.users instead, so no address is typed into a
-- query, echoed in a result grid, or captured in a screenshot.
--
-- Privilege posture is unchanged. app_owner remains select-only to
-- `authenticated` (0001_schema.sql); this insert runs as the privileged
-- dashboard role, which is the only path to ownership by design. RLS is not
-- touched, relaxed, or bypassed here.
--
-- Idempotent: re-running after the row exists is a no-op.

do $$
declare
  user_count  integer;
  owner_count integer;
  target      uuid;
begin
  select count(*) into owner_count from public.app_owner;

  if owner_count > 0 then
    raise notice 'Ownership already granted (% row(s) in app_owner). No change made.', owner_count;
    return;
  end if;

  select count(*) into user_count from auth.users;

  -- Nothing to grant to. Creating a placeholder row here would point the gate
  -- at an account that cannot sign in, which fails worse than not running.
  if user_count = 0 then
    raise exception
      'no account exists in auth.users — create Erik''s user first (Authentication -> Users -> Add user), then re-run this file';
  end if;

  -- Ambiguity must stop the script rather than resolve itself: picking "the
  -- newest" account would hand sole ownership of the CRM to whichever row
  -- happened to sort first. The count is reported; no address is printed.
  if user_count > 1 then
    raise exception
      'auth.users holds % accounts — cannot infer the owner. Grant explicitly with: insert into public.app_owner (user_id, email) select id, email from auth.users where id = ''<the-uuid>'';',
      user_count;
  end if;

  select id into target from auth.users;

  insert into public.app_owner (user_id, email)
  select id, email from auth.users where id = target
  on conflict (user_id) do nothing;

  raise notice 'Ownership granted to the single existing auth account. app_owner now holds % row(s).',
    (select count(*) from public.app_owner);
end $$;

-- Verify the gate resolves for the granted account, rather than assuming the
-- insert was sufficient. is_owner() reads auth.uid(), which is NULL in the SQL
-- editor, so it cannot be called directly here; check the predicate it
-- evaluates instead.
do $$
declare
  n integer;
begin
  select count(*) into n from public.app_owner o join auth.users u on u.id = o.user_id;
  if n <> 1 then
    raise exception 'expected exactly 1 app_owner row joined to a real auth account, found %', n;
  end if;
  raise notice 'Verified: app_owner holds 1 row bound to a live auth account; is_owner() will return true for it.';
end $$;

notify pgrst, 'reload schema';
