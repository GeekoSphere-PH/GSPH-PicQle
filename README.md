# PickleballQ

## Architecture

This app has two deployable pieces:

- **This repo** (Next.js, deployed on Vercel) — the UI and thin `app/api/rating/*`
  proxy routes. It holds no rating logic of its own.
- **[pickleballq-rating-service](../pickleballq-rating-service)** (Python/FastAPI,
  deployed on Render) — the actual Glicko-2 + queue/round-balancing computation.
  It's stateless: every request carries the full player state it needs, every
  response returns the full updated state. It stores nothing.

The browser only ever talks to this app's own `/api/rating/*` routes. Those
routes call the Render service server-to-server, attaching a shared API key
that never reaches the browser.

## Supabase + Vercel setup

1. Create a Supabase project.
2. Run the SQL from [supabase/schema.sql](supabase/schema.sql) in the Supabase SQL editor.
3. Copy [.env.example](.env.example) to `.env.local` and fill in the values.
4. Deploy to Vercel and add the same environment variables in the Vercel project settings.

### Required environment variables

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `RATING_SERVICE_URL` — base URL of the deployed rating microservice (e.g. `https://pickleballq-rating-service.onrender.com`)
- `RATING_SERVICE_API_KEY` — must match the `API_KEY` set on the Render service
- `RATING_SERVICE_TIMEOUT_MS` — optional, defaults to 25000

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
