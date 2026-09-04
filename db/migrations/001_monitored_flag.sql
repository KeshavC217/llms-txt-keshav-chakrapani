-- Separates "a site we have generated for" from "a site we watch".
--
-- Every generation is now stored so a repeat request is served from the
-- database instead of re-crawling a third party. That means a row exists for
-- every URL anyone submits — which must not silently enrol them all in the
-- monitoring schedule, or the crawler would revisit every one-off lookup
-- forever and the dashboard would fill with sites nobody chose to watch.
--
-- `status` already means "is this site healthy" (it pauses after repeated
-- failures), so overloading it for intent would conflate two different
-- questions. A separate flag keeps them independent: the scheduler wants
-- monitored = true AND status = 'active'.

alter table public.tracked_sites
  add column if not exists monitored boolean not null default false;

-- Rows that existed before this migration were created by explicit tracking.
update public.tracked_sites set monitored = true where monitored = false;

drop index if exists tracked_sites_due_idx;
create index if not exists tracked_sites_due_idx
  on public.tracked_sites (next_check_at)
  where status = 'active' and monitored = true;
