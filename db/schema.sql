-- The one table this project needs, in the shape the code expects.
--
-- Run it in the Supabase SQL editor on a new project. It is idempotent, so
-- running it against an existing project applies whatever is missing and
-- leaves the rest alone - which is also how the two historical migrations
-- (the monitoring columns, then source/published_at) get applied to a
-- deployment that predates them.
--
-- lib/store.ts tolerates an older schema on purpose: a read asking for a
-- column that does not exist returns nothing at all rather than a partial row,
-- so it asks for the full set and falls back to the original four. That is a
-- safety net for the window between a deploy and a migration, not a substitute
-- for running this.

create table if not exists public.generations (
  url          text primary key,
  llms_txt     text        not null,
  content_hash text        not null,
  generated_at timestamptz not null default now()
);

-- Monitoring. A row carries its own schedule, so a site that changes often is
-- checked often and a static one is left alone; see lib/monitor.ts.
alter table public.generations
  -- Fingerprint of the site's structure, model-free: what a check compares.
  add column if not exists structure_hash       text,
  -- Fingerprint of the sitemap alone, which settles most checks for one request.
  add column if not exists sitemap_hash         text,
  add column if not exists last_checked_at      timestamptz,
  -- Last time a check found the site had actually moved.
  add column if not exists changed_at           timestamptz,
  add column if not exists change_count         integer     not null default 0,
  -- Halves on a change, grows by half without one, bounded by
  -- MONITOR_MIN/MAX_INTERVAL_HOURS.
  add column if not exists check_interval_hours integer     not null default 24;

-- Whose file this is. 'generated' means we crawled the site and wrote it;
-- 'published' means the site publishes its own and this is a copy, in which
-- case published_at is where it lives so a check can re-read it rather than
-- crawl and replace someone's curation with ours.
alter table public.generations
  add column if not exists source       text not null default 'generated',
  add column if not exists published_at text;

-- The saved list, newest first.
create index if not exists generations_generated_at_idx
  on public.generations (generated_at desc);

-- The monitoring queue: least recently checked first, never-checked rows ahead
-- of everything.
create index if not exists generations_last_checked_at_idx
  on public.generations (last_checked_at asc nulls first);

-- RLS on with NO policies at all, which is the point rather than an omission.
--
-- The publishable key reaches this table with the anonymous role, and with RLS
-- enabled and nothing granting it access, that role can read and write nothing
-- - verified against the live project, where a browser-key select returns zero
-- rows and a browser-key insert is refused outright. Everything goes through
-- the server with SUPABASE_SECRET_KEY, which carries BYPASSRLS and never
-- leaves it.
--
-- Adding a policy here would expose the table to any visitor holding the
-- publishable key, which is every visitor.
alter table public.generations enable row level security;

-- A row is a site we know about, and the state of its file.
--
-- Crawling moved off the request path, so a row now exists before its file
-- does: POST /api/generate inserts one as 'queued' and returns, and the worker
-- fills it in. The queue and the public catalogue are therefore the same list,
-- which is what lets the catalogue show a site that is still being crawled
-- rather than hiding it until it is finished.
--
-- 'queued'   nobody has picked it up yet
-- 'crawling' a worker has claimed it; claimed_at is when
-- 'ready'    llms_txt is the answer
-- 'failed'   error says why, in the words the caller would have been given
alter table public.generations
  add column if not exists status     text not null default 'ready',
  add column if not exists error      text,
  add column if not exists claimed_at timestamptz;

-- A queued row has no file yet. Existing rows are unaffected: they all have one.
alter table public.generations alter column llms_txt drop not null;

-- What the worker asks for on every pass.
create index if not exists generations_status_idx
  on public.generations (status, generated_at);
