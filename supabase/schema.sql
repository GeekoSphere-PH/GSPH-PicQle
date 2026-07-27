create extension if not exists pgcrypto;

-- `id` is a DB-generated surrogate key. `name` is the human-chosen string
-- the app actually addresses players by everywhere (Map keys, activePool,
-- teamA/teamB, the rating microservice's playerId) — it must stay unique so
-- server-side code can reliably map the app's id to a row.
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  mu double precision not null default 1500,
  sigma double precision not null default 350,
  volatility double precision not null default 0.06,
  games_played integer not null default 0,
  -- Epoch milliseconds, not a Postgres timestamp: the rating engine (both
  -- lib/rating-types.ts and the Python microservice) does inactivity-decay
  -- math directly on this as a number (`(now - lastActiveTimestamp) /
  -- MS_PER_DAY`). Storing it as bigint means no conversion is needed
  -- anywhere it's read or written.
  last_active_timestamp bigint not null default (extract(epoch from now()) * 1000)::bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  team_a text[] not null,
  team_b text[] not null,
  winner text not null check (winner in ('A', 'B')),
  created_at timestamptz not null default now()
);

-- RLS stays enabled with no policies defined below: this denies all access
-- to the anon and authenticated roles. Only the Supabase service role key
-- can read/write these tables, since the service role always bypasses RLS
-- regardless of policy. That's intentional — the app has no login flow, and
-- only trusted server-side Next.js route handlers (never the browser)
-- should ever query these tables, using SUPABASE_SERVICE_ROLE_KEY.
alter table public.players enable row level security;
alter table public.matches enable row level security;
