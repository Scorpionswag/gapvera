-- GapVera scheduled follow-up sweep.
--
-- Run AFTER `supabase functions deploy followup-sweep`.
--
-- The function is idempotent on the UTC date (see its job_runs claim), so a
-- duplicate or retried invocation does no second mutation. That property is
-- what makes an at-least-once scheduler safe here.
--
-- Replace <project-ref> and use the SERVICE ROLE key. Run this in the SQL
-- editor only — the key must never reach the repo or the browser bundle.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 13:00 UTC = 08:00 EST. Once daily: the sweep only stages drafts, so there is
-- nothing to gain from running it hourly.
select cron.schedule(
  'gapvera-followup-sweep',
  '0 13 * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/followup-sweep',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- Inspect:   select * from cron.job;
--            select * from cron.job_run_details order by start_time desc limit 10;
--            select * from public.job_runs order by started_at desc limit 10;
-- Unschedule: select cron.unschedule('gapvera-followup-sweep');
