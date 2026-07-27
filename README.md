# PickleballQ

## Architecture

This app has two deployable pieces:

- **This repo** (Next.js, deployed on Vercel) — the UI, the persistent
  `PlayerRating`/match history in Supabase, and thin `app/api/rating/*` proxy
  routes. It holds no rating logic of its own.
- **[pickleballq-rating-service](../pickleballq-rating-service)** (Python/FastAPI,
  deployed on Render) — the actual Glicko-2 + queue/round-balancing computation.
  It's stateless: every request carries the full player state it needs, every
  response returns the full updated state. It stores nothing.

The browser only ever talks to this app's own routes — never Supabase or the
rating microservice directly:

- `/api/players` (GET) loads the persisted roster from Supabase.
- `/api/rating/*` proxy to the Render microservice server-to-server (a
  shared API key never reaches the browser), and persist the result back to
  Supabase for the two actions that change ratings (`join`, `match`).
  `leave` and `round` don't touch the database — per the reference PDF,
  queue membership never affects a player's persistent rating.

Supabase access is service-role only (`lib/server/supabase-admin.ts`); RLS on
`players`/`matches` denies the `anon` and `authenticated` roles entirely
(see `supabase/schema.sql`), since there's no login flow and nothing
client-side should ever query these tables. `lib/server/player-repository.ts`
is the only place that maps between the app's string player id (used
everywhere: `Map` keys, `activePool`, `teamA`/`teamB`, the rating
microservice's `playerId`) and a `players` row — the DB's own `uuid` primary
key never surfaces above that layer; the row is looked up/upserted by its
unique `name` column instead.

## Supabase + Vercel setup

1. Create a Supabase project.
2. Run the SQL from [supabase/schema.sql](supabase/schema.sql) in the Supabase SQL editor.
3. Copy [.env.example](.env.example) to `.env.local` and fill in the values.
4. Deploy to Vercel and add the same environment variables in the Vercel project settings.

### Required environment variables

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RATING_SERVICE_URL` — base URL of the deployed rating microservice (e.g. `https://pickleballq-rating-service.onrender.com`)
- `RATING_SERVICE_API_KEY` — must match the `API_KEY` set on the Render service
- `RATING_SERVICE_TIMEOUT_MS` — optional, defaults to 25000

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is not currently used by any code path (there's
no client-side Supabase access) — safe to leave unset.

### Local development

Run the rating microservice locally first (see its own README), then:

```bash
npm install
npm run dev
```

with `.env.local` pointing `RATING_SERVICE_URL` at your local instance (e.g.
`http://localhost:4000`) and `RATING_SERVICE_API_KEY` matching the `API_KEY`
you set for it.

### Cold starts

Render's free plan spins the rating service down after inactivity — the
first request after that can take 30+ seconds. The `/api/rating/*` routes
surface this as a `504` with a "waking up, try again" message rather than
hanging; the UI shows that as an error banner and leaves your in-progress
input untouched.
