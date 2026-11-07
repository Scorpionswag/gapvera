-- GapVera private document storage.
--
-- Run AFTER 0001_schema.sql. Creates the 'documents' bucket PRIVATE if it does
-- not exist, then installs owner-only policies on it.
--
-- Acceptance criterion 6: documents live in private Storage and are reachable
-- only through an authenticated request or a short-lived signed URL. A public
-- bucket would satisfy "it works" and fail the actual requirement, so the
-- bucket's private flag is checked here rather than assumed.

-- Create the bucket private if absent. This is the same object the dashboard's
-- "New bucket, Public OFF" creates; doing it here removes a manual step whose
-- omission silently blocks the rest of this file. Never flips an existing
-- bucket's visibility — an already-public bucket is a decision to surface, not
-- to quietly rewrite.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- Refuse if the bucket is public. Better to abort than to install policies
-- that imply protection the bucket does not have.
do $$
declare
  is_public boolean;
begin
  select public into is_public from storage.buckets where id = 'documents';
  if is_public is null then
    raise exception 'bucket "documents" does not exist and could not be created — create it in Storage -> New bucket (Public OFF)';
  end if;
  if is_public then
    raise exception 'bucket "documents" is PUBLIC — set it to private before applying these policies';
  end if;
end $$;

-- Owner-only access to objects in the documents bucket, all four verbs.
-- storage.objects already has RLS enabled by Supabase; these policies are
-- additive to it.
drop policy if exists documents_owner_select on storage.objects;
create policy documents_owner_select
  on storage.objects for select
  to authenticated
  using (bucket_id = 'documents' and public.is_owner());

drop policy if exists documents_owner_insert on storage.objects;
create policy documents_owner_insert
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'documents' and public.is_owner());

drop policy if exists documents_owner_update on storage.objects;
create policy documents_owner_update
  on storage.objects for update
  to authenticated
  using (bucket_id = 'documents' and public.is_owner())
  with check (bucket_id = 'documents' and public.is_owner());

drop policy if exists documents_owner_delete on storage.objects;
create policy documents_owner_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'documents' and public.is_owner());

-- No policy is granted to anon on this bucket. With RLS enabled and no
-- permissive anon policy, an unauthenticated Storage call is refused — which
-- is the fail-closed behaviour acceptance criterion 8 asks for.
