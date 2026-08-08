# Add "Sign in with Google" as an app-wide access gate (via Supabase Auth)

## Context

The app currently has **no authentication at all**. There's no `middleware.ts`/`proxy.ts`, no login page, and `supabase/schema.sql` explicitly documents that RLS denies `anon`/`authenticated` on `players`/`matches`/`game_sessions` — only the server-only service-role client (`lib/server/supabase-admin.ts`) can touch the DB. That means today, anyone who finds the URL can open the queue app, join, start sessions, and record match results.

The ask: gate the whole app behind Google Sign-In so only people who authenticate with a Google account can use it — open to **any** Google account (no email/domain allowlist), and **not** tied to per-player identity (a signed-in user is just "an authenticated person," not linked to a specific `players` row). This is the smallest-footprint option: it doesn't touch the `players`/`matches`/`game_sessions` schema, RLS, or the service-role data path at all — it only adds a login wall in front of the existing app.

**Does Google Sign-In work well with Supabase?** Yes — Google is a first-class, well-supported OAuth provider in Supabase Auth, and it's Supabase's own documented Next.js integration path (listed directly in Next.js's own [Auth Libraries](https://supabase.com/docs/guides/getting-started/quickstarts/nextjs) list). Supabase already backs this project's data layer, so no new backend service is introduced — this only adds the `@supabase/ssr` package for session handling.

**Next.js 16 gotcha for this repo** (per `AGENTS.md`'s "not the Next.js you know" warning): the `middleware.ts` file convention is **deprecated and renamed to `proxy.ts`** in this Next.js version (confirmed in `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`) — exporting a `proxy()` function instead of `middleware()`. Any tutorial/training-data example that says `middleware.ts` is stale for this codebase; must use `proxy.ts`.

## External setup (done outside the codebase, not by code changes)

1. **Google Cloud Console** — create an OAuth 2.0 Client ID (Web application):
   - Authorized JavaScript origins: the app's URL(s) (e.g. `http://localhost:3000`, prod domain).
   - Authorized redirect URI: the Supabase project's auth callback — `https://<project-ref>.supabase.co/auth/v1/callback`.
2. **Supabase Dashboard → Authentication → Providers → Google** — enable it, paste the Google Client ID + Client Secret from step 1.
3. **Supabase Dashboard → Authentication → URL Configuration** — set Site URL and add Redirect URLs for `http://localhost:3000/auth/callback` and the prod equivalent.

No RLS/schema changes needed — `players`/`matches`/`game_sessions` stay service-role-only exactly as today; this only adds a session gate in front of the app.

## Code changes

1. **Install `@supabase/ssr`** — the supported package for cookie-based Supabase sessions in Next.js Server Components/Route Handlers/Proxy (`@supabase/supabase-js` alone isn't enough for SSR cookie handling).

2. **`lib/supabase/client.ts`** (new) — browser client using `createBrowserClient` from `@supabase/ssr`, `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the anon key is already in `.env.example`, currently unused — this is the first consumer of it). Used only for the login button's `signInWithOAuth` call and sign-out — never for data access (that stays on the service-role admin client).

3. **`lib/supabase/server.ts`** (new) — server client using `createServerClient` from `@supabase/ssr`, wired to `next/headers` cookies, for use in `proxy.ts` and the auth callback route.

4. **`app/auth/callback/route.ts`** (new) — Route Handler that receives Google's redirect, calls `supabase.auth.exchangeCodeForSession(code)`, then redirects into the app.

5. **`app/login/page.tsx`** (new) — simple page with a "Sign in with Google" button (client component) calling `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: <origin>/auth/callback } })`. Matches existing Tailwind styling used in `app/page.tsx`/`app/layout.tsx`.

6. **`proxy.ts`** (new, project root — **not** `middleware.ts`) — exports `proxy(request)`, uses the server Supabase client to check for a session on every request except `/login`, `/auth/callback`, static assets, and `/api/*` if those need to stay reachable without a browser session (check `app/api/` routes' current callers first). Unauthenticated requests redirect to `/login`; authenticated requests pass through. Use the `matcher` config with the standard negative-match pattern shown in Next's proxy docs to exclude `_next/static`, `_next/image`, and asset files.

7. **Sign-out** — add a small sign-out control (e.g. in `app/layout.tsx` or a header component) that calls `supabase.auth.signOut()` client-side and redirects to `/login`.

8. **Env vars** — no new variables needed; `NEXT_PUBLIC_SUPABASE_ANON_KEY` already exists in `.env.example`/`.env.local`, just goes from unused to used. Update the comment in `.env.example` that currently says "Not currently used by any code path."

## Call-out / risk to flag to the user

Since this is intentionally an **open-to-any-Google-account** gate with no allowlist, *any* Google user who discovers the app's URL and clicks "Sign in with Google" will get full access to the queue app (same as everyone else — there's no role distinction). This is a much lower bar than "only our club members," so worth confirming this matches the intended threat model (e.g. "keep search engines/randoms out" vs. "keep out everyone except our players").

## Verification

1. `npm run dev`, visit `http://localhost:3000` while logged out — should redirect to `/login`.
2. Click "Sign in with Google," complete the OAuth consent screen, confirm redirect back to the app and that the queue UI loads.
3. Refresh the page and open a new tab to the app root — session should persist (cookie-based), no repeated login prompt.
4. Sign out — confirm redirect to `/login` and that the app root now redirects back to `/login` again.
5. Confirm existing functionality (queue, match recording, rating service calls) still works once authenticated — this change should be purely additive in front of the existing app.
