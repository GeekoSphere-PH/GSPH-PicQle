# Add "Strict rotation + Best rating match" queuing mode

## Context

The app currently offers two queuing modes when building the next round: **Fair rotation** (longest-waiter guaranteed a spot, rating only breaks ties) and **Best rating match** (always groups the 4 closest-rated players, ignoring wait time entirely — meaning someone who just came off court could be re-matched immediately if their rating happens to cluster with the due-up players). Users want a third option that keeps rotation's fairness guarantee (nobody is skipped indefinitely) while still balancing team ratings as well as possible among the players who are actually due up. This closes the gap between the two existing modes: fairness without giving up on match balance.

This is a two-repo system: `pickleballq` (Next.js) is a thin UI/proxy with no matchmaking logic of its own; `pickleballq-rating-service` (Python/FastAPI, deployed separately on Render) owns the actual algorithm (`build_next_round` in `rating_engine.py`) and is stateless — every request carries full state. Both repos independently define a `RoundMode` literal that must stay in sync by hand (no shared codegen).

## Naming

- Internal wire literal: `strictRotationBestMatch`
- UI label: "Strict rotation + Best rating match"
- UI explainer (added to the ternary/lookup at `page.tsx:385-389`): *"Whoever has waited the most rounds gets a guaranteed spot — but among this round's due-up players, teams are grouped to keep ratings as close as possible."* This must read distinctly from the existing "Best rating match" explainer, since both do rating-based grouping — the differentiator is that the new mode never lets someone skip the rotation queue.

## Core algorithm design

Today, `build_next_round` (`pickleballq-rating-service/app/rating_engine.py:198-236`) conflates "who plays next" and "how they're teamed" into one step: it sorts the pool by a mode-dependent key, then slices the sorted list into rigid consecutive blocks of 4, and only balances teams *within* each fixed block via `_split_minimizing_gap` (`rating_engine.py:239-253`). The new mode requires **decoupling these two decisions**:

**Phase A — determine the due-up set (hard fairness constraint).** Reuse rotation's existing sort key `(rounds_waited, mu)` descending. `slots = courts_available * 4`, rounded down to a multiple of 4 if the pool doesn't divide evenly (identical tie-break behavior to today's rotation slicing — Python's `sorted()` is stable, so ties fall back to `active_pool` order/join order). `due_up = sorted_ids[:slots]`; everyone else goes straight to `leftover`.

**Phase B — optimize grouping + teaming within `due_up` only.** New function (e.g. `_assign_groups_minimizing_gap`) that searches for the partition of `due_up` into `courts_available` groups of 4 (plus a `_split_minimizing_gap` call per group) that minimizes the **sum** of per-court rating gaps, not just the gap within a single arbitrarily-sliced block.

**Complexity handling (confirmed: exact + greedy fallback).** Brute-force partition search is trivial through `courts_available <= 3` (12 players: ~156K partition×split combinations, sub-100ms) but blows up past that (16 players ≈ 164M combinations, risky against the 25s client timeout / 30s route `maxDuration`, compounded by Render cold starts). Since the live UI only ever sends `courtsAvailable: 1` today (`page.tsx:148`), the exact path covers all real current usage.
- Add a constant `EXACT_SEARCH_MAX_COURTS = 3`.
- At or below the threshold: exact recursive/backtracking search over partitions, reusing `_split_minimizing_gap` per candidate group.
- Above the threshold: fall back to the existing "rating"-mode heuristic (sort by `mu`, chop into consecutive blocks of 4) restricted to the `due_up` set — document in the docstring (mirroring the honesty of the existing docstring at `rating_engine.py:205-210`) that this is a known, accepted regression from global optimality at scale.

**Invariant to test/assert:** every member of `due_up` must end up in exactly one group — Phase B must never drop someone, or the fairness guarantee silently breaks. `set(due_up) == set(matched_ids)`.

## Files to change

**`pickleballq-rating-service`** (implement + test first — see rollout order below):
- `app/models.py:6` — `RoundMode = Literal["rating", "rotation", "strictRotationBestMatch"]`; `BuildRoundRequest.mode` default at line 76 stays `"rotation"` (no behavior change for existing callers).
- `app/rating_engine.py:198-253` — add Phase A/B logic and the new grouping function alongside `build_next_round`/`_split_minimizing_gap`, which are reused as-is.
- `tests/test_rating_engine.py` — extend the pattern at lines 88-125 (`test_rotation_mode_guarantees_the_longest_waiting_player_a_spot`, `test_rating_mode_ignores_wait_time`) with:
  - fairness-guarantee parity test (same "outlier who's waited longest" fixture, assert they're matched)
  - a grouping-quality test with an engineered 8-player (2-court) fixture where naive consecutive slicing is worse than the optimal partition, to catch a "just reused rotation's slicing" non-solution
  - n=1 court equivalence test (grouping search is moot, should match rotation mode's output exactly)
  - greedy-fallback test above `EXACT_SEARCH_MAX_COURTS`, asserting the invariant still holds
  - odd-sized due-up boundary test (e.g. 13 players / 3 courts) pinning the deterministic tie-break
  - a property test across random pools: `set(matched_ids) | set(leftover) == set(active_pool)`
- `tests/test_api.py` — extend the `test_build_round_happy_path`-style test (~lines 89-105) with a `mode: "strictRotationBestMatch"` HTTP-layer case.

**`pickleballq`** (only after the service above is deployed and verified live):
- `lib/rating-types.ts:26-30` — widen `RoundMode` union to include `"strictRotationBestMatch"`; update the doc comment to describe all three modes.
- `app/page.tsx:385-409` — add a third radio button and extend the explainer copy (consider converting the ternary to a `Record<RoundMode, string>` lookup for cleanliness). No changes needed to `runRoundBuilder` (`page.tsx:139-169`) — `mode: roundMode` already passes through opaquely — or to `app/api/rating/round/route.ts:41`, which just widens along with the type.

No Supabase schema changes — `supabase/schema.sql` only stores player ratings and match results; mode/roundsWaited are ephemeral client-held state, never persisted.

## Key complexities / risks to flag

1. **Two-repo deploy coordination is the biggest operational risk.** `Literal["rating","rotation"]` on the service will reject (`422`) a request with the new mode if the service hasn't been redeployed yet. **Required order: deploy the rating service first, verify it's live (hit `/health`, then a real `/build-round` call with the new mode via curl using `RATING_SERVICE_API_KEY`), only then ship the main-app UI change.** Reverse order is the failure mode to avoid.
2. **Render cold starts** (30+s after idle) compound with the new mode's (small but nonzero) extra computation — worth a manual warm-up hit right after each deploy rather than relying solely on the existing 25s client timeout/30s `maxDuration` absorption (`rating-service-client.ts:27-32`, `handle-rating-error.ts`).
3. **No shared type enforcement** between `models.py:6` and `rating-types.ts:30` — the literal string must be spelled identically by hand in both repos; worth a cross-referencing comment in both files since no OpenAPI-codegen step exists today.
4. **Global vs. court-by-court optimization** — must optimize across all courts simultaneously within the due-up set (not greedily court-by-court), since greedy-per-court is what today's "rating" mode already approximates and is known to strand better pairings.
5. **422 error surfacing** — `handle-rating-error.ts` currently only special-cases 504; a 422 (e.g. from a stale-service/new-mode mismatch) falls into the generic "Rating service is unavailable" 502-style message rather than a clearer "mode not supported yet" error. Acceptable for v1, but note it as a rough edge.

## Verification

- Run `pytest` in `pickleballq-rating-service` (new + existing tests, especially `test_rating_engine.py` and `test_api.py`) to confirm the new mode's fairness guarantee, grouping quality, and edge cases.
- Manually curl `/build-round` on the deployed Render service with `mode: "strictRotationBestMatch"` before touching the main app, per the rollout order above.
- After the main-app change ships: run the dev server, select the new radio button in the Round builder card, and confirm end-to-end that (a) the longest-waiting player is always included in the next round, and (b) team splits look rating-balanced among whoever's due up — cross-check against a hand-computed expected grouping for a small test roster.