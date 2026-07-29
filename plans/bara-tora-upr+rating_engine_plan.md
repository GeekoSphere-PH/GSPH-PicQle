# Plan 2 (separate, unrelated to Plan 1 above): Rating system overhaul — BARA/TORA/UPR

**This is an independent plan.** It does not touch, depend on, or get executed alongside Plan 1 above (the queuing-mode change), which is left as-is per your instruction. Track them and approve/execute them separately.

## Context

The original business PRD (`pickleballq/reference/PickleBall Application.pdf`) specifies a rating model the current implementation never built: a **Universal Pickleball Rating (UPR)** blended from two independent tracks — **BARA** (Basic/Recreational Rating) and **TORA** (Tournament Rating) — each with a "Live" value (updates per game) and a "Latest Published" value (frozen monthly, "every 1st/2nd day of month"), and a game-status lifecycle of **Pending → Registered → Rated** gated by a player confirmation step. The currently implemented Python rating service instead evolved independently to fix a specific queue/leaderboard bug, using Glicko-2 as a convenient math engine, but with one unified rating per player, no track split, no publish snapshot, and no confirmation gate — matches are rated the instant a result is submitted.

You've confirmed you want to materialize this PRD requirement now, scoped to four pieces: dual BARA/TORA tracks, UPR blending, live-vs-published monthly snapshot, and confirmation-gated rating updates. Tournament bracket/eligibility management is explicitly deferred (functional requirements, "later"). Since no tournament scheduling exists yet, TORA matches are tagged manually at match-entry time by whoever submits the result (the Queue Master role) rather than through any bracket system.

## Key finding: this requires zero changes to the rating service

`pickleballq-rating-service`'s engine (`app/rating_engine.py`) and API (`app/routers/*.py`, `app/models.py`) are already fully **track-agnostic** — every function just processes whatever `players: Dict[str, PlayerRating]` dict a caller hands it; it has no notion of "BARA" or "TORA." Calling `/update-ratings` once with the four participants' BARA values, and separately (for a different match) with their TORA values, already works today, unchanged. **This whole overhaul is main-app (`pickleballq`) + Supabase work only** — unlike the queuing-mode plan, there's no two-repo deploy-coordination risk here, because the Python service never needs to be redeployed.

The one real gap this surfaces: `on_player_join`'s inactivity-sigma-inflation step is only reachable via the live-queue join flow, which is BARA-only in this design. TORA matches bypass the queue entirely, so nothing would ever inflate a TORA player's `sigma` between tournaments unless we deliberately call `/player-join` for TORA participants too — see Risk 4.

## Where UPR blending lives: main app, not the rating service

New pure function `pickleballq/lib/upr.ts`:
```
weight = 1 / sigma²   (per track)
uprMu = (baraMu·wBara + toraMu·wTora) / (wBara + wTora)
uprSigma = 1 / sqrt(wBara + wTora)
conservativeUpr = uprMu - 2·uprSigma
```
This is precision-weighted blending using each track's `sigma` as confidence — the standard Bayesian way to combine two independent estimates, and symmetric with the existing `conservative_rating = mu - 2*sigma` concept already in `rating_engine.py`. It's pure arithmetic on two already-fetched `(mu, sigma)` pairs, needs no engine round-trip, and keeps the rating service's "generic math box" design intact.

**Two assumptions this fills in for the PRD (flagging both, since the PRD names the concept but not the formula):**
1. Precision-weighting (`1/sigma²`) as the blend weight — defensible given Glicko-2 already produces a sigma per track, but not a documented business rule.
2. **Zero-games exclusion**: a player who's never played a tournament match still has a TORA row seeded at default `mu=1500, sigma=350`. Blending against that untested default would unfairly drag a well-established BARA player's UPR toward 1500 (e.g., BARA mu=1800/sigma=60 blended against fresh TORA comes out ≈1791 — a ~9-point unearned penalty). Rule: **exclude a track from the blend while its `games_played = 0`**; UPR equals the other track's value verbatim until both tracks have at least one game.

## Data model changes (`pickleballq/supabase/schema.sql`)

**`players`** — becomes identity-only (`id`, `name`, `created_at`); rating columns move out. Drop them only in a later cleanup migration, not immediately (rollback safety on a single shared production DB with no staging — see Migration section).

**New `player_ratings`** — one row per player per track, replacing the single rating on `players`:
```sql
player_id uuid not null references public.players(id) on delete cascade,
track text not null check (track in ('bara', 'tora')),
mu double precision not null default 1500,
sigma double precision not null default 350,
volatility double precision not null default 0.06,
games_played integer not null default 0,
last_active_timestamp bigint not null default (extract(epoch from now()) * 1000)::bigint,
updated_at timestamptz not null default now(),
primary key (player_id, track)
```

**`matches`** — add track + confirmation-workflow columns:
```sql
track text not null default 'bara' check (track in ('bara', 'tora')),
status text not null default 'pending' check (status in ('pending', 'registered', 'rated', 'void')),
submitted_by text,
confirm_by timestamptz not null,      -- created_at + 48h (PRD's "active invite" window)
hard_expiry timestamptz not null,     -- created_at + 7 days (PRD's "valid for one week")
confirmed_by text[] not null default '{}',
registered_at timestamptz,
rated_at timestamptz,
voided_at timestamptz
```

**New `published_ratings`** — one row per player per monthly publish, decoupled from live values (columns: `player_id`, `publish_period` date, `bara_mu/sigma/volatility/games_played`, `tora_mu/sigma/volatility/games_played`, `upr_rating`, `published_at`; unique on `(player_id, publish_period)`). "Latest Published" = the row with `max(publish_period)` per player, exposed via a `latest_published_ratings` view (`distinct on (player_id) order by publish_period desc`).

**New `publish_runs`** (`publish_period` date primary key, `published_at`) — idempotency guard so a double cron-fire (the PRD's "1st or 2nd of month" wording implies exactly this) doesn't double-publish.

All new tables get RLS enabled with no policies, matching the existing service-role-only convention on `players`/`matches`.

## Confirmation-status semantics (assumption, flagged for confirmation)

The PRD names Pending → Registered → Rated but doesn't define the boundary between "Registered" and "Rated," nor the confirmation quorum. Proposed v1 rule:
- **Quorum**: any one participant confirming moves the match to Rated (simplest rule consistent with the PRD's "Player - confirm posted game" language). Revisit if the business wants "one per team" or "all four."
- **Registered/Rated collapse**: since no additional gate exists yet, the first confirmation stamps `registered_at` and `rated_at` together in one action; `registered_at` is kept for PRD-fidelity/audit display only.
- **Expiry**: `confirm_by` (48h) is soft/informational (UI marks it overdue); `hard_expiry` (7 days) is hard and **auto-voids** (not auto-rates) the match — auto-rating on silence would defeat the point of a consent gate.

## Main app changes

**`lib/server/player-repository.ts`** — becomes track-aware: `loadAllPlayers(track)`, `upsertPlayers(track, players[])` (resolving/creating the `players` row by `name` first, then upserting `player_ratings` on `(player_id, track)`), `recordMatch(match, track, submittedBy)` (inserts `status='pending'` with computed `confirm_by`/`hard_expiry`), `confirmMatch(matchId, confirmingPlayerId)`, `listPendingMatches()`. `deleteAllData()` extended to truncate the three new tables too.

**Route changes:**
- `app/api/players/route.ts` — `GET` gains `?track=bara|tora` (default `bara`).
- `app/api/rating/match/route.ts` — repurposed from "apply match result" to "submit match result": accepts `{matchResult, track, submittedBy}`, no longer calls `updateMatchRatings`, just inserts a `pending` row and returns it. This is the architecturally significant change — submission and rating are now decoupled in time.
- New `app/api/rating/match/[matchId]/confirm/route.ts` — validates the match is `pending` and unexpired (lazily voiding if not), validates the confirming player is a participant, appends to `confirmed_by`, and on first confirmation loads the track-specific ratings for the four participants, calls the existing unchanged `updateMatchRatings` (`lib/server/rating-service-client.ts`), upserts back into `player_ratings`, and stamps `rated_at`/`status='rated'`.
- New `app/api/rating/match/pending/route.ts` — `GET`, backs a "pending confirmations" UI list.
- `app/api/rating/join|leave|round/route.ts` — no contract changes; main app simply always sources `players` from `loadAllPlayers('bara')`, since the live queue/round-builder is scoped BARA-only.
- `app/api/rating/leaderboard/route.ts` — no contract change; a UPR leaderboard is computed route-side from two already-fetched track leaderboards via `lib/upr.ts`, no new rating-service call.

**Expiry mechanism**: primary is lazy check-on-access inside the confirm/pending routes (correctness doesn't depend on cron cadence); secondary is a daily housekeeping cron (`app/api/cron/expire-matches/route.ts`) sweeping stale rows for players who never come back.

**Monthly publish job**: `app/api/cron/publish-ratings/route.ts`, scheduled in `vercel.json` (`0 6 1,2 * *`, matching the PRD's "1st/2nd day" wording — the handler must be idempotent via `publish_runs` since that fires twice), protected by a `CRON_SECRET` header check. Logic: normalize `publish_period` to first-of-month, insert-or-skip into `publish_runs`, then for every player compute `upr_rating` via `lib/upr.ts` and insert one `published_ratings` row per player.

**UI (`app/page.tsx`, secondary to the data/API design)**: track radio (BARA/TORA) on match submission; button relabeled ("Submit for confirmation"); new "Pending confirmations" panel with a per-participant Confirm action; leaderboard gains a BARA/TORA/UPR toggle; later, "Latest Published" figures surfaced alongside live ones once the publish job lands.

## Migration/rollout for existing players

1. Additive migration: create `player_ratings`/`published_ratings`/`publish_runs`; add new `matches` columns (`status` defaulting to `'rated'` for the backfill step). Leave `players.mu/sigma/...` in place for now.
2. Backfill BARA: copy each player's existing single rating into `player_ratings` as their `'bara'` row verbatim — preserves all history exactly.
3. Backfill TORA: seed a fresh `'tora'` row per player at the same defaults `on_player_join` uses for a new player (mu=1500, sigma=350, volatility=0.06) — no prior tournament data exists to seed from.
4. Backfill `matches`: existing rows get `track='bara'`, `status='rated'`, `rated_at=created_at` (best-effort; harmless since these are already baked into current mu/sigma and this is display/audit-only).
5. Update `player-repository.ts` to the track-aware functions above.
6. Only after Phase 1 (below) is confirmed stable in production: a later, separate migration drops the now-unused rating columns from `players` — deliberately not done immediately, since this is a single shared production Supabase instance with no staging environment (per the app's own "Single-instance warning" copy).

## Ordered implementation phases

1. **Dual-track schema, still-synchronous updates.** Migration + backfill; track-aware `player-repository.ts`; `/api/rating/match` still calls `updateMatchRatings` immediately (no gating yet) but against the correct track; `matches.status` hardcoded `'rated'`; `/join`/`/leave`/`/round` hardcoded to `'bara'`; UI gets track selector + BARA/TORA leaderboard toggle only, no UPR yet. *Why first:* retires the biggest structural risk (splitting one rating into two) using the already-understood synchronous flow, and validates the "zero rating-service changes" finding in production before adding workflow complexity.
2. **Confirmation-gated workflow.** Submission creates `pending` rows; confirm route + quorum rule + registered→rated transition; pending-list route; lazy + cron expiry; UI pending panel. *Why second:* the novel, highest-risk piece — no multi-step state machine exists in this codebase today — isolated from Phase 1's already-proven data-model change so each phase stays separately testable/revertible.
3. **UPR blending (live).** `lib/upr.ts`; UPR leaderboard from already-fetched BARA/TORA leaderboards. *Why third:* purely additive and read-only, safest once the two structurally riskier phases are proven, and easiest to validate against real accumulated data.
4. **Monthly publish snapshot.** `published_ratings`/`publish_runs`; publish cron; `vercel.json` entries; UI "Latest Published" display. *Why last:* depends on Phase 3's blended UPR existing, and a monthly batch job has no bearing on day-to-day correctness — lowest urgency.

## Key risks/complexities

1. **Two-repo coordination — not a risk here.** Confirmed the engine is fully track-agnostic; zero `pickleballq-rating-service` deploys needed, unlike the queuing-mode plan's contract surface.
2. **Confirmation-gating breaks the "instant leaderboard" live-queue UX.** Today, submitting a match result and seeing the leaderboard update is one synchronous action people watch happen courtside. After Phase 2, a submitted match sits `pending` — possibly for hours — so the round-builder won't reflect a just-played game until someone confirms it. The PRD's own 24h/48h/1-week language reads far more naturally for asynchronous tournament results than a same-room live doubles game. This plan gates both tracks uniformly as scoped, but **worth confirming before Phase 2 ships** whether BARA should stay synchronous (gate TORA only) rather than applying the gate everywhere.
3. **Data migration risk.** Single shared production Supabase instance, no staging (per the app's own warning copy) — schema changes land against live data mid-session. Mitigated by an additive-only Phase 1 migration, deferring the `players` column drop.
4. **TORA sigma-inflation gap.** `_inflate_uncertainty_for_inactivity` in `rating_engine.py` is only reached via `on_player_join`; TORA matches bypass the queue/join flow entirely in this design, so nothing would inflate a TORA player's sigma between tournaments without a deliberate fix. Concrete fix: before computing a TORA `update-ratings` call, sequentially call the existing `/player-join` for each of the four participants (chaining the returned dict), reusing `on_player_join`'s seed-or-inflate behavior with zero engine changes — just an added call site. Separately, expect TORA sigma to structurally sit near its ceiling between infrequent tournaments even with this fix — that's Glicko-2 working as designed, not a bug, but worth reflecting in player-facing copy.
5. **Order-of-confirmation vs. order-of-play.** Ratings apply in confirmation order, not necessarily play order, when a player has multiple overlapping pending matches. Flagged as a known v1 limitation; no blocking logic proposed now.
6. **No auth/identity enforcement.** The "any one participant confirms" quorum is exactly as spoofable as every other free-text-name action already in this app (including the existing reset-all-data button) — not a risk this plan introduces, but confirmation is meant to represent consent, and the current no-login identity model can't actually enforce that.
7. **Vercel Cron plan-tier limits.** Confirm the current Vercel plan supports the proposed cron cadence before relying on it; mitigated by lazy expiry-on-access being the primary correctness mechanism, so cron cadence only affects UI freshness, not correctness.
8. **UPR formula and zero-games exclusion are both gap-filling assumptions**, not documented business rules — confirm both before treating them as final.

## Critical files for implementation
- `pickleballq/supabase/schema.sql`
- `pickleballq/lib/server/player-repository.ts`
- `pickleballq/app/api/rating/match/route.ts`
- `pickleballq/lib/server/rating-service-client.ts` (reused unchanged)
- `pickleballq/app/page.tsx`
- `pickleballq/vercel.json`
- `pickleballq-rating-service/app/rating_engine.py` (reference only — confirms no engine changes needed)

## Verification
- After Phase 1: manually submit a BARA match and a TORA match, confirm both tracks' `player_ratings` update independently and correctly via Supabase inspection; confirm existing BARA history matches pre-migration values exactly.
- After Phase 2: submit a match, confirm it sits `pending` and does NOT affect `player_ratings` or the leaderboard until confirmed; confirm the hard-expiry auto-void path with a manually backdated `hard_expiry`.
- After Phase 3: hand-compute the expected UPR for a small fixture (known BARA/TORA mu/sigma) and compare against `lib/upr.ts`'s output, including the zero-games-exclusion case.
- After Phase 4: manually trigger the publish route (or backdate `publish_runs`) and confirm exactly one `published_ratings` row per player per period, and that a second trigger in the same period is a no-op.
