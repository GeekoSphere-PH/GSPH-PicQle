create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mu double precision not null default 1500,
  sigma double precision not null default 350,
  volatility double precision not null default 0.06,
  games_played integer not null default 0,
  last_active_timestamp timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  team_a text[] not null,
  team_b text[] not null,
  winner text not null check (winner in ('A', 'B')),
  created_at timestamptz not null default now()
);

alter table public.players enable row level security;
alter table public.matches enable row level security;

create policy "Allow read access for authenticated users" on public.players
  for select using (auth.role() = 'authenticated');

create policy "Allow insert access for authenticated users" on public.players
  for insert with check (auth.role() = 'authenticated');

create policy "Allow update access for authenticated users" on public.players
  for update using (auth.role() = 'authenticated');

create policy "Allow read access for authenticated users" on public.matches
  for select using (auth.role() = 'authenticated');

create policy "Allow insert access for authenticated users" on public.matches
  for insert with check (auth.role() = 'authenticated');
