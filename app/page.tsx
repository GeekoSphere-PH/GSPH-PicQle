"use client";

import { useEffect, useState } from "react";

import { mapToRecord, recordToMap } from "@/lib/map-utils";
import type { GameSession, LeaderboardEntry, PlayerRating, RoundBuildResult, RoundMode, VersusMode } from "@/lib/rating-types";

const ROUND_MODE_EXPLAINERS: Record<RoundMode, string> = {
  rotation: "Whoever has waited the most rounds gets a guaranteed spot, even if that makes the match less balanced.",
  rating: "Always picks the closest 4 by rating, regardless of who's waited longest.",
  strictRotationBestMatch:
    "Whoever has waited the most rounds gets a guaranteed spot — but among this round's due-up players, teams are grouped to keep ratings as close as possible.",
};

const VERSUS_MODE_EXPLAINERS: Record<VersusMode, string> = {
  doubles: "2 vs 2 — each match uses 4 players (default).",
  singles: "1 vs 1 — each match uses 2 players.",
};

function matchSizeFor(versusMode: VersusMode): number {
  return versusMode === "singles" ? 2 : 4;
}

// A court's current match. Locked (no editing/swapping) once built — the
// only action available is selecting then confirming a winner, which frees
// the court and pulls in the next match. `id` is client-only (the API's
// MatchResult has none, and this state never round-trips to the server).
type ActiveMatch = {
  id: string;
  teamA: string[];
  teamB: string[];
  selectedWinner?: "A" | "B";
};

const COMMIT_SHA = process.env.NEXT_PUBLIC_COMMIT_SHA ?? "unknown";
const COMMIT_SHA_SHORT = COMMIT_SHA === "unknown" ? "unknown" : COMMIT_SHA.slice(0, 7);

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);

  if (!response.ok) {
    let message = `Request to ${path} failed (${response.status}).`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      // ignore parse failure, keep the default message
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `Request to ${path} failed (${response.status}).`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      // ignore parse failure, keep the default message
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export default function Home() {
  const [players, setPlayers] = useState<Map<string, PlayerRating>>(() => new Map());
  const [activePool, setActivePool] = useState<string[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [newPlayerId, setNewPlayerId] = useState("");
  // Fixed-position court slots — index is the court's on-screen position,
  // which never shifts. `null` means idle/waiting; confirming a match nulls
  // its slot in place rather than removing it, so the next match that fills
  // it lands in the same spot instead of the list re-flowing.
  const [courtSlots, setCourtSlots] = useState<(ActiveMatch | null)[]>(() => [null]);
  const [roundsWaited, setRoundsWaited] = useState<Record<string, number>>({});
  const [roundMode, setRoundMode] = useState<RoundMode>("rotation");
  const [versusMode, setVersusMode] = useState<VersusMode>("doubles");
  const [courtsAvailable, setCourtsAvailable] = useState(1);
  // Non-null while a game is Started — locks roundMode/versusMode/
  // courtsAvailable from editing and gates auto round-building (see
  // topUpCourts). Persisted server-side so a page refresh mid-session
  // restores the lock instead of resetting to defaults.
  const [gameSession, setGameSession] = useState<GameSession | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PlayerRating is persistent (Supabase); the leaderboard and all rating
  // math live entirely in the external microservice. On mount, load the
  // real roster from Supabase, then ask the microservice to rank it — this
  // page never computes or stores anything itself.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { players: playerRecord } = await getJson<{ players: Record<string, PlayerRating> }>("/api/players");
        if (cancelled) return;
        const loadedPlayers = recordToMap(playerRecord);
        setPlayers(loadedPlayers);

        const { leaderboard: loadedLeaderboard } = await postJson<{ leaderboard: LeaderboardEntry[] }>(
          "/api/rating/leaderboard",
          { players: mapToRecord(loadedPlayers) },
        );
        if (!cancelled) setLeaderboard(loadedLeaderboard);

        // If a game is already Started (e.g. another tab, or this page was
        // refreshed mid-session), restore the lock and the settings it
        // locked in instead of showing the defaults.
        const { session } = await getJson<{ session: GameSession | null }>("/api/game-session");
        if (cancelled || !session) return;
        setGameSession(session);
        setRoundMode(session.roundMode);
        setVersusMode(session.versusMode);
        setCourtsAvailable(session.courtsAvailable);
        setCourtSlots((current) =>
          current.length < session.courtsAvailable
            ? [...current, ...Array<null>(session.courtsAvailable - current.length).fill(null)]
            : current,
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load players.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Accepts one id or a comma-separated batch (e.g. "p1, p2, p3"). Joins are
  // sent one at a time, each using the previous join's freshly-returned pool
  // and player map (not the outer closure, which won't see earlier joins in
  // this same batch until the next render) — this keeps each new player's
  // seeded rating based on the pool average correct as the batch progresses.
  const addPlayers = async (rawInput: string) => {
    const ids = Array.from(new Set(rawInput.split(",").map((s) => s.trim()).filter(Boolean)));
    if (ids.length === 0 || isBusy) return;

    setIsBusy(true);
    setError(null);
    try {
      let currentPool = activePool;
      let currentPlayers = players;
      for (const id of ids) {
        if (currentPool.includes(id)) continue;

        const data = await postJson<{
          player: PlayerRating;
          activePool: string[];
          players: Record<string, PlayerRating>;
          leaderboard: LeaderboardEntry[];
        }>("/api/rating/join", { playerId: id, activePool: currentPool, players: mapToRecord(currentPlayers) });

        currentPlayers = recordToMap(data.players);
        currentPool = data.activePool;
        setPlayers(currentPlayers);
        setActivePool(currentPool);
        setLeaderboard(data.leaderboard);
      }
      topUpCourts(currentPool);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join queue.");
    } finally {
      setIsBusy(false);
    }
  };

  const addPlayer = async () => {
    await addPlayers(newPlayerId);
    setNewPlayerId("");
  };

  const joinQueue = async (playerId: string) => {
    await addPlayers(playerId);
  };

  const leaveQueue = async (playerId: string) => {
    if (isBusy) return;

    setIsBusy(true);
    setError(null);
    try {
      const data = await postJson<{ activePool: string[]; players: Record<string, PlayerRating> }>(
        "/api/rating/leave",
        { playerId, activePool, players: mapToRecord(players) },
      );
      setActivePool(data.activePool);
      setPlayers(recordToMap(data.players));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to leave queue.");
    } finally {
      setIsBusy(false);
    }
  };

  // `options` lets callers pass freshly-known values (e.g. the pool just
  // returned by a join/apply request) instead of the possibly-stale state
  // closure, since React state updates aren't visible until the next render.
  const buildRound = async (options?: {
    activePool?: string[];
    versusMode?: VersusMode;
    courtsAvailable?: number;
  }) => {
    if (isBusy) return;

    const poolToUse = options?.activePool ?? activePool;
    const versusModeToUse = options?.versusMode ?? versusMode;
    const courtsToUse = options?.courtsAvailable ?? courtsAvailable;

    setIsBusy(true);
    setError(null);
    try {
      const data = await postJson<RoundBuildResult>("/api/rating/round", {
        activePool: poolToUse,
        players: mapToRecord(players),
        courtsAvailable: courtsToUse,
        roundsWaited,
        mode: roundMode,
        versusMode: versusModeToUse,
      });
      // Each newly-built match fills the first still-idle (null) slot(s), in
      // court order, so it lands wherever a court most recently freed up
      // rather than at the end of the list. courtsToUse (the number of open
      // slots requested, not necessarily the global courts setting) bounds
      // how many come back here, so this should never run out of null slots
      // to fill — the `while` below is just a defensive fallback.
      const newCards: ActiveMatch[] = data.matches.map((match) => ({ ...match, id: crypto.randomUUID() }));
      setCourtSlots((current) => {
        const next = [...current];
        let cardIndex = 0;
        for (let i = 0; i < next.length && cardIndex < newCards.length; i++) {
          if (next[i] === null) {
            next[i] = newCards[cardIndex];
            cardIndex++;
          }
        }
        while (cardIndex < newCards.length) {
          next.push(newCards[cardIndex]);
          cardIndex++;
        }
        return next;
      });
      // Matched players are now on a court, not queued; leftover carries into
      // the next rotation per the reference spec.
      setActivePool(data.leftover);
      setRoundsWaited(data.roundsWaited);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build round.");
    } finally {
      setIsBusy(false);
    }
  };

  // Tops up any open (null) court slots whenever a queue-changing action
  // (join, confirming a match, a settings change) leaves room for another
  // match — this is what makes round-building "continuous" without a manual
  // button press, and lets one freed court refill independently of any other
  // still in-progress court. Called from event handlers (not an effect) so
  // state updates from the triggering action are passed in directly rather
  // than read stale.
  const topUpCourts = (
    pool: string[],
    options?: { versusMode?: VersusMode; courtSlots?: (ActiveMatch | null)[]; gameSession?: GameSession | null },
  ) => {
    // No auto-building outside a Started game — settings aren't locked in
    // yet, so there's nothing to build against. `options.gameSession` lets
    // callers pass a freshly-known value (e.g. right after starting) since
    // the `gameSession` state closure won't see it until the next render.
    const session = options && "gameSession" in options ? options.gameSession : gameSession;
    if (!session) return;

    const mode = options?.versusMode ?? versusMode;
    const slots = options?.courtSlots ?? courtSlots;
    const freeSlots = slots.filter((slot) => slot === null).length;
    if (freeSlots <= 0 || pool.length < matchSizeFor(mode)) return;
    void buildRound({ activePool: pool, versusMode: mode, courtsAvailable: freeSlots });
  };

  const changeVersusMode = (next: VersusMode) => {
    if (isBusy) return;
    // Active matches are locked in once built — a versus-mode change only
    // affects what gets built into any open courts, never matches already
    // on the board.
    setVersusMode(next);
    topUpCourts(activePool, { versusMode: next });
  };

  const changeCourtsAvailable = (next: number) => {
    setCourtsAvailable(next);

    let updatedSlots = courtSlots;
    if (next > courtSlots.length) {
      updatedSlots = [...courtSlots, ...Array<null>(next - courtSlots.length).fill(null)];
    } else if (next < courtSlots.length) {
      // Trim idle slots off the end down to the target count. Active
      // matches are locked in and never forcibly removed, so if there
      // aren't enough trailing idle slots to reach the target, the board
      // temporarily stays larger than `courtsAvailable` until those finish.
      const trimmed = [...courtSlots];
      while (trimmed.length > next && trimmed[trimmed.length - 1] === null) {
        trimmed.pop();
      }
      updatedSlots = trimmed;
    }
    setCourtSlots(updatedSlots);
    topUpCourts(activePool, { courtSlots: updatedSlots });
  };

  const startGame = async () => {
    if (isBusy || gameSession) return;

    setIsBusy(true);
    setError(null);
    try {
      const data = await postJson<{ session: GameSession }>("/api/game-session", {
        roundMode,
        versusMode,
        courtsAvailable,
      });
      setGameSession(data.session);
      setCourtSlots((current) =>
        current.length < courtsAvailable
          ? [...current, ...Array<null>(courtsAvailable - current.length).fill(null)]
          : current,
      );
      topUpCourts(activePool, { gameSession: data.session });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start game.");
    } finally {
      setIsBusy(false);
    }
  };

  const stopGame = async () => {
    if (isBusy || !gameSession) return;

    setIsBusy(true);
    setError(null);
    try {
      await postJson("/api/game-session/stop", { sessionId: gameSession.id });
      setGameSession(null);
      setActivePool([]);
      // Drop idle placeholders — nothing will auto-fill them until Start
      // again. In-progress matches are left as-is; they can still be
      // selected and confirmed.
      setCourtSlots((current) => current.filter((slot) => slot !== null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop game.");
    } finally {
      setIsBusy(false);
    }
  };

  const selectWinner = (matchId: string, winner: "A" | "B") => {
    setCourtSlots((current) => current.map((slot) => (slot?.id === matchId ? { ...slot, selectedWinner: winner } : slot)));
  };

  const confirmMatch = async (match: ActiveMatch) => {
    if (isBusy || !match.selectedWinner) return;

    setIsBusy(true);
    setError(null);
    try {
      const data = await postJson<{ players: Record<string, PlayerRating>; leaderboard: LeaderboardEntry[] }>(
        "/api/rating/match",
        { matchResult: { teamA: match.teamA, teamB: match.teamB, winner: match.selectedWinner }, players: mapToRecord(players) },
      );
      setPlayers(recordToMap(data.players));
      setLeaderboard(data.leaderboard);

      // Players return to the queue once their match is done.
      const returning = [...match.teamA, ...match.teamB].filter((id) => !activePool.includes(id));
      const newPool = [...activePool, ...returning];
      setActivePool(newPool);

      // Free this match's slot in place — it keeps its board position; only
      // the content changes once the next match fills back into it. If no
      // game is Started, though, nothing will ever fill it again, so drop
      // the now-idle slot entirely rather than leaving a dangling
      // "Waiting for players…" placeholder.
      const clearedSlots = courtSlots
        .map((slot) => (slot?.id === match.id ? null : slot))
        .filter((slot) => gameSession !== null || slot !== null);
      setCourtSlots(clearedSlots);
      topUpCourts(newPool, { courtSlots: clearedSlots });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply match result.");
    } finally {
      setIsBusy(false);
    }
  };

  const resetAllData = async () => {
    if (isBusy) return;
    const confirmed = window.confirm(
      "Single-instance warning: this clears ALL players and match data from the shared database, right now, for every connected user. There is no undo. Continue?",
    );
    if (!confirmed) return;

    setIsBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/players", { method: "DELETE" });
      if (!response.ok) {
        let message = `Request to /api/players failed (${response.status}).`;
        try {
          const data = await response.json();
          if (data?.error) message = data.error;
        } catch {
          // ignore parse failure, keep the default message
        }
        throw new Error(message);
      }

      setPlayers(new Map());
      setActivePool([]);
      setLeaderboard([]);
      setCourtSlots(Array<null>(courtsAvailable).fill(null));
      setRoundsWaited({});
      setGameSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset data.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 p-6 pb-14 text-zinc-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold">Pickleball rating queue demo</h1>
              <p className="mt-2 max-w-2xl text-sm text-zinc-400">
                This minimal interface lets you test the queue model, build rounds from the live pool, and apply match outcomes to the Glicko-2 rating engine. All rating computation runs in a separate microservice — this page only sends and receives state.
              </p>
            </div>
            <button
              onClick={resetAllData}
              disabled={isBusy}
              className="shrink-0 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-950/70 disabled:opacity-50"
            >
              Reset all data
            </button>
          </div>
          <p className="mt-2 text-xs text-red-400/80">
            Single-instance warning: this database is shared. Resetting clears every player and match for all connected users, with no undo.
          </p>
          {error ? (
            <p className="mt-4 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</p>
          ) : null}

          <div className="mt-4 rounded-xl border border-cyan-900/60 bg-cyan-950/20 p-4 text-sm text-zinc-300">
            <p className="font-medium text-cyan-300">What do &quot;mu&quot; and &quot;sigma&quot; mean?</p>
            <ul className="mt-2 space-y-1.5">
              <li>
                <span className="font-medium text-zinc-100">mu (μ)</span> — the player&apos;s skill estimate, on the same
                scale as a normal rating (everyone starts at 1500). Win matches and it goes up; lose and it goes down.
                Higher mu = the system thinks you&apos;re better.
              </li>
              <li>
                <span className="font-medium text-zinc-100">sigma (σ)</span> — how confident the system is in that mu.
                It starts high for a brand-new player (we&apos;re guessing) and shrinks as they play more games (we&apos;re
                sure). It also creeps back up if someone stops playing for a while, since their true skill may have
                drifted.
              </li>
              <li>
                <span className="font-medium text-zinc-100">Leaderboard rank</span> — uses{" "}
                <span className="font-mono text-cyan-300">mu − 2×sigma</span> (a &quot;conservative rating&quot;), not raw
                mu. This stops a new player from jumping to #1 after one lucky win — they need a few games to prove
                the rating before it counts at full value.
              </li>
            </ul>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Players</h2>
              <div className="flex gap-2">
                <input
                  value={newPlayerId}
                  onChange={(event) => setNewPlayerId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addPlayer();
                  }}
                  placeholder="Add players, comma-separated"
                  disabled={isBusy}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm disabled:opacity-50"
                />
                <button
                  onClick={addPlayer}
                  disabled={isBusy}
                  className="rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  Add player
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {Array.from(players.values()).map((player) => {
                const inPool = activePool.includes(player.id);
                return (
                  <div key={player.id} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium">{player.id}</p>
                        <p className="text-xs text-zinc-500">
                          Games: {player.gamesPlayed}
                          {inPool && roundsWaited[player.id] ? ` • waiting ${roundsWaited[player.id]} round${roundsWaited[player.id] === 1 ? "" : "s"}` : ""}
                        </p>
                      </div>
                      <span className={`rounded-full px-2 py-1 text-xs ${inPool ? "bg-emerald-600/20 text-emerald-400" : "bg-zinc-800 text-zinc-300"}`}>
                        {inPool ? "Queued" : "Idle"}
                      </span>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => joinQueue(player.id)}
                        disabled={isBusy}
                        className="rounded-lg border border-cyan-700 px-2 py-1 text-xs disabled:opacity-50"
                      >
                        Join queue
                      </button>
                      <button
                        onClick={() => leaveQueue(player.id)}
                        disabled={isBusy}
                        className="rounded-lg border border-zinc-700 px-2 py-1 text-xs disabled:opacity-50"
                      >
                        Leave queue
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-xl font-semibold">Leaderboard</h2>
            <div className="mt-4 space-y-3">
              {leaderboard.map((player) => (
                <div key={player.id} className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
                  <div className="flex items-center justify-between">
                    <span>{player.id}</span>
                    <span className="font-semibold text-cyan-400">{Math.round(player.conservativeRating)}</span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-zinc-800">
                    <div
                      className="h-2 rounded-full bg-cyan-500"
                      style={{ width: `${Math.min(100, Math.max(0, player.conservativeRating / 20))}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs text-zinc-400">
                    mu {Math.round(player.mu)} • sigma {Math.round(player.sigma)} • games {player.gamesPlayed}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold">Game Profile Setting</h2>
                <p className="mt-1 text-xs text-zinc-500">
                  {gameSession
                    ? `Started ${new Date(gameSession.startedAt).toLocaleTimeString()} — settings locked until Stop.`
                    : "Settings are editable until you Start."}
                </p>
              </div>
              {gameSession ? (
                <button
                  onClick={stopGame}
                  disabled={isBusy}
                  className="shrink-0 rounded-lg bg-red-700 px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  Stop
                </button>
              ) : (
                <button
                  onClick={startGame}
                  disabled={isBusy}
                  className="shrink-0 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  Start
                </button>
              )}
            </div>

            <p className="mt-4 text-sm text-zinc-400">{ROUND_MODE_EXPLAINERS[roundMode]}</p>
            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              <label className="rounded-lg border border-zinc-700 px-3 py-2">
                <input
                  type="radio"
                  checked={roundMode === "rotation"}
                  onChange={() => setRoundMode("rotation")}
                  disabled={isBusy || gameSession !== null}
                  className="mr-2"
                />
                Fair rotation
              </label>
              <label className="rounded-lg border border-zinc-700 px-3 py-2">
                <input
                  type="radio"
                  checked={roundMode === "rating"}
                  onChange={() => setRoundMode("rating")}
                  disabled={isBusy || gameSession !== null}
                  className="mr-2"
                />
                Best rating match
              </label>
              <label className="rounded-lg border border-zinc-700 px-3 py-2">
                <input
                  type="radio"
                  checked={roundMode === "strictRotationBestMatch"}
                  onChange={() => setRoundMode("strictRotationBestMatch")}
                  disabled={isBusy || gameSession !== null}
                  className="mr-2"
                />
                Strict rotation + Best rating match
              </label>
            </div>

            <p className="mt-4 text-sm text-zinc-400">{VERSUS_MODE_EXPLAINERS[versusMode]}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <label className="rounded-lg border border-zinc-700 px-3 py-2">
                <input
                  type="radio"
                  checked={versusMode === "doubles"}
                  onChange={() => changeVersusMode("doubles")}
                  disabled={isBusy || gameSession !== null}
                  className="mr-2"
                />
                Doubles
              </label>
              <label className="rounded-lg border border-zinc-700 px-3 py-2">
                <input
                  type="radio"
                  checked={versusMode === "singles"}
                  onChange={() => changeVersusMode("singles")}
                  disabled={isBusy || gameSession !== null}
                  className="mr-2"
                />
                Singles
              </label>
              <label className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2">
                Courts
                <input
                  type="number"
                  min={1}
                  value={courtsAvailable}
                  onChange={(event) => changeCourtsAvailable(Math.max(1, Number(event.target.value) || 1))}
                  disabled={isBusy || gameSession !== null}
                  className="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm disabled:opacity-50"
                />
              </label>
            </div>

            <button
              onClick={() => topUpCourts(activePool)}
              disabled={isBusy || !gameSession}
              className="mt-4 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              Fill open courts now
            </button>
            <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
              <p className="text-sm text-zinc-400">Current queue</p>
              <p className="mt-2 font-medium">{activePool.join(" → ") || "(empty)"}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-xl font-semibold">Status board</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Active matches are locked until you select a winner and confirm — confirming frees the court and pulls in the next match from the queue.
            </p>
            <div className="mt-4 space-y-4">
              {courtSlots.map((match, index) => (
                // Keyed by court position (not match id) so a slot's DOM node
                // is reused in place when its match changes — this is what
                // keeps the board from re-flowing when a court finishes.
                <div key={index}>
                  {match ? (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
                      <p className="text-sm text-zinc-300">
                        {match.teamA.join(", ")} <span className="text-zinc-500">vs</span> {match.teamB.join(", ")}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-3 text-sm">
                        <label className="rounded-lg border border-zinc-700 px-3 py-2">
                          <input
                            type="radio"
                            checked={match.selectedWinner === "A"}
                            onChange={() => selectWinner(match.id, "A")}
                            disabled={isBusy}
                            className="mr-2"
                          />
                          {match.teamA.join(", ")} won
                        </label>
                        <label className="rounded-lg border border-zinc-700 px-3 py-2">
                          <input
                            type="radio"
                            checked={match.selectedWinner === "B"}
                            onChange={() => selectWinner(match.id, "B")}
                            disabled={isBusy}
                            className="mr-2"
                          />
                          {match.teamB.join(", ")} won
                        </label>
                      </div>
                      <button
                        onClick={() => confirmMatch(match)}
                        disabled={isBusy || !match.selectedWinner}
                        className="mt-3 rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
                      >
                        Confirm result
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-500">
                      Waiting for players…
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center bg-[#F44336] px-4 py-2 text-sm font-semibold text-white shadow-[0_-2px_8px_rgba(0,0,0,0.3)]">
        Live commit: <span className="ml-1.5 font-mono">{COMMIT_SHA_SHORT}</span>
      </div>
    </main>
  );
}
