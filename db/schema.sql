-- Supabase schema for llms.txt monitoring.
--
-- Run once in the Supabase SQL editor. This file is the source of truth for
-- the schema (the tables live in Supabase, not in a migrations framework).
--
-- ACCESS MODEL: tracked sites are anonymous and global — there is no login.
-- Every read and write goes through the Next.js server using the service-role
-- key; the browser never talks to Supabase directly. So RLS is enabled with
-- NO policies, which denies all anon/authenticated access outright while the
-- service role bypasses it. That is deliberately stricter than writing
-- permissive anon policies: it means a leaked publishable key grants nothing.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- tracked_sites: one row per site being monitored.
-- ---------------------------------------------------------------------------
create table if not exists public.tracked_sites (
  id                    uuid primary key default gen_random_uuid(),
  -- Normalized root URL (scheme + host, no trailing slash). Unique so that
  -- tracking the same site twice is a no-op rather than a duplicate crawl.
  url                   text        not null unique,
  created_at            timestamptz not null default now(),
  last_checked_at       timestamptz,
  -- The cron claims work by asking for rows where next_check_at <= now(),
  -- which keeps scheduling in the database instead of in the scheduler.
  next_check_at         timestamptz not null default now(),
  check_interval_hours  integer     not null default 24 check (check_interval_hours > 0),
  use_ai                boolean     not null default false,
  -- active | paused. A site that fails repeatedly is paused rather than
  -- retried forever against a dead host.
  status                text        not null default 'active' check (status in ('active', 'paused')),
  consecutive_failures  integer     not null default 0,
  last_error            text
);

create index if not exists tracked_sites_due_idx
  on public.tracked_sites (next_check_at)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- snapshots: every generated version of a site's llms.txt.
-- ---------------------------------------------------------------------------
create table if not exists public.snapshots (
  id           uuid        primary key default gen_random_uuid(),
  site_id      uuid        not null references public.tracked_sites(id) on delete cascade,
  created_at   timestamptz not null default now(),
  llms_txt     text        not null,
  -- sha256 of llms_txt. A re-crawl that produces an identical document writes
  -- no snapshot, so the history is a list of real changes rather than a log of
  -- every time the cron happened to run.
  content_hash text        not null,
  page_count   integer     not null,
  ai_status    text,
  -- Structured diff against the previous snapshot; null on the first one.
  -- { pagesAdded: [...], pagesRemoved: [...], titlesChanged: [...],
  --   descriptionsChanged: [...], sectionsChanged: [...] }
  diff         jsonb
);

create index if not exists snapshots_site_created_idx
  on public.snapshots (site_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: on, with no policies. Denies anon and authenticated entirely; the
-- server's service-role key bypasses RLS by design.
-- ---------------------------------------------------------------------------
alter table public.tracked_sites enable row level security;
alter table public.snapshots     enable row level security;
