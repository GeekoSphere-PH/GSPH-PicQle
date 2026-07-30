"use client";

import { useEffect, useState } from "react";

import { mapToRecord, recordToMap } from "@/lib/map-utils";
import type { LeaderboardEntry, MatchResult, PlayerRating, RoundBuildResult, RoundMode, VersusMode } from "@/lib/rating-types";

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
  const [teamA, setTeamA] = useState<string[]>([]);
  const [teamB, setTeamB] = useState<string[]>([]);
  const [winner, setWinner] = useState<"A" | "B">("A");
  const [pendingMatches, setPendingMatches] = useState<MatchResult[]>([]);
  const [roundsWaited, setRoundsWaited] = useState<Record<string, number>>({});
  const [roundMode, setRoundMode] = useState<RoundMode>("rotation");
  const [versusMode, setVersusMode] = useState<VersusMode>("doubles");
  const [courtsAvailable, setCourtsAvailable] = useState(1);
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
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load players.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const addOrJoin = async (rawId: string) => {
    const id = rawId.trim();
    if (!id || activePool.includes(id) || isBusy) return;

    setIsBusy(true);
    setError(null);
    try {
      const data = await postJson<{
        player: PlayerRating;
        activePool: string[];
        players: Record<string, PlayerRating>;
        leaderboard: LeaderboardEntry[];
      }>("/api/rating/join", { playerId: id, activePool, players: mapToRecord(players) });

      setPlayers(recordToMap(data.players));
      setActivePool(data.activePool);
      setLeaderboard(data.leaderboard);
      maybeAutoBuild(data.activePool);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join queue.");
    } finally {
      setIsBusy(false);
    }
  };

  const addPlayer = async () => {
    await addOrJoin(newPlayerId);
    setNewPlayerId("");
  };

  const joinQueue = async (playerId: string) => {
    await addOrJoin(playerId);
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
      setPendingMatches(data.matches);
      // Matched players are now on a court, not queued; leftover carries into
      // the next rotation per the reference spec.
      setActivePool(data.leftover);
      setRoundsWaited(data.roundsWaited);

      // Carry the built match straight into the "Apply match result" panel
      // as chips, so there's no manual retyping of ids.
      if (data.matches.length > 0) {
        setTeamA(data.matches[0].teamA);
        setTeamB(data.matches[0].teamB);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build round.");
    } finally {
      setIsBusy(false);
    }
  };

  // Triggers the next round automatically whenever a queue-changing action
  // (join, apply match result, versus-mode change) leaves enough players
  // queued for at least one match and no round is already pending — this is
  // what makes round-building "continuous" without a manual button press.
  // Called from event handlers (not an effect) so state updates from the
  // triggering action are passed in directly rather than read stale.
  const maybeAutoBuild = (
    pool: string[],
    options?: { versusMode?: VersusMode; courtsAvailable?: number; pendingMatches?: MatchResult[] },
  ) => {
    const mode = options?.versusMode ?? versusMode;
    const courts = options?.courtsAvailable ?? courtsAvailable;
    const pending = options?.pendingMatches ?? pendingMatches;
    if (pending.length > 0 || courts <= 0 || pool.length < matchSizeFor(mode)) return;
    void buildRound({ activePool: pool, versusMode: mode, courtsAvailable: courts });
  };

  const changeVersusMode = (next: VersusMode) => {
    if (isBusy) return;
    if (pendingMatches.length > 0) {
      // Discard the round built under the old versus mode and return those
      // players to the queue, then immediately try to rebuild sized for the
      // new mode.
      const returning = pendingMatches.flatMap((match) => [...match.teamA, ...match.teamB]);
      const newPool = [...activePool, ...returning.filter((id) => !activePool.includes(id))];
      setActivePool(newPool);
      setPendingMatches([]);
      setTeamA([]);
      setTeamB([]);
      setVersusMode(next);
      maybeAutoBuild(newPool, { versusMode: next, pendingMatches: [] });
    } else {
      setVersusMode(next);
      maybeAutoBuild(activePool, { versusMode: next });
    }
  };

  const applyMatch = async () => {
    if (teamA.length === 0 || teamB.length === 0 || isBusy) return;

    setIsBusy(true);
    setError(null);
    try {
      const data = await postJson<{ players: Record<string, PlayerRating>; leaderboard: LeaderboardEntry[] }>(
        "/api/rating/match",
        { matchResult: { teamA, teamB, winner }, players: mapToRecord(players) },
      );
      setPlayers(recordToMap(data.players));
      setLeaderboard(data.leaderboard);

      // Players return to the queue once their match is done.
      const returning = [...teamA, ...teamB].filter((id) => !activePool.includes(id));
      const newPool = [...activePool, ...returning];
      setActivePool(newPool);

      // Drop the resolved match off the pending queue (FIFO — good enough
      // for this minimal demo UI, no need to match the applied teams back
      // to their exact origin slot) and auto-fill the next pending match,
      // if any, into the apply panel. Once this empties, the next round
      // builds automatically.
      const remainingMatches = pendingMatches.slice(1);
      setPendingMatches(remainingMatches);
      if (remainingMatches.length > 0) {
        setTeamA(remainingMatches[0].teamA);
        setTeamB(remainingMatches[0].teamB);
      } else {
        setTeamA([]);
        setTeamB([]);
      }
      maybeAutoBuild(newPool, { pendingMatches: remainingMatches });
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
      setPendingMatches([]);
      setRoundsWaited({});
      setTeamA([]);
      setTeamB([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset data.");
    } finally {
      setIsBusy(false);
    }
  };

  const removeFromTeam = (team: "A" | "B", playerId: string) => {
    const setter = team === "A" ? setTeamA : setTeamB;
    setter((current) => current.filter((id) => id !== playerId));
  };

  const addToTeam = (team: "A" | "B", playerId: string) => {
    if (!playerId) return;
    const setter = team === "A" ? setTeamA : setTeamB;
    setter((current) => (current.includes(playerId) ? current : [...current, playerId]));
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
                  placeholder="Add player"
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
            <h2 className="text-xl font-semibold">Round builder</h2>
            <p className="mt-2 text-sm text-zinc-400">{ROUND_MODE_EXPLAINERS[roundMode]}</p>
            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              <label className="rounded-lg border border-zinc-700 px-3 py-2">
                <input
                  type="radio"
                  checked={roundMode === "rotation"}
                  onChange={() => setRoundMode("rotation")}
                  className="mr-2"
                />
                Fair rotation
              </label>
              <label className="rounded-lg border border-zinc-700 px-3 py-2">
                <input
                  type="radio"
                  checked={roundMode === "rating"}
                  onChange={() => setRoundMode("rating")}
                  className="mr-2"
                />
                Best rating match
              </label>
              <label className="rounded-lg border border-zinc-700 px-3 py-2">
                <input
                  type="radio"
                  checked={roundMode === "strictRotationBestMatch"}
                  onChange={() => setRoundMode("strictRotationBestMatch")}
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
                  disabled={isBusy}
                  className="mr-2"
                />
                Doubles
              </label>
              <label className="rounded-lg border border-zinc-700 px-3 py-2">
                <input
                  type="radio"
                  checked={versusMode === "singles"}
                  onChange={() => changeVersusMode("singles")}
                  disabled={isBusy}
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
                  onChange={(event) => setCourtsAvailable(Math.max(1, Number(event.target.value) || 1))}
                  disabled={isBusy}
                  className="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm disabled:opacity-50"
                />
              </label>
            </div>

            <button
              onClick={() => buildRound()}
              disabled={isBusy}
              className="mt-4 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              Force rebuild now
            </button>
            <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
              <p className="text-sm text-zinc-400">Current queue</p>
              <p className="mt-2 font-medium">{activePool.join(" → ")}</p>
              {pendingMatches.length > 0 ? (
                <ul className="mt-4 space-y-2 text-sm text-zinc-300">
                  {pendingMatches.map((match, index) => (
                    <li key={index} className="rounded-lg border border-zinc-800 px-3 py-2">
                      {match.teamA.join(", ")} vs {match.teamB.join(", ")}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-zinc-500">No round built yet.</p>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-xl font-semibold">Apply match result</h2>
            <p className="mt-2 text-sm text-zinc-400">Filled in automatically from the last built round — add, remove, or swap players below if needed.</p>
            <div className="mt-4 space-y-4">
              {(["A", "B"] as const).map((team) => {
                const members = team === "A" ? teamA : teamB;
                const otherMembers = team === "A" ? teamB : teamA;
                const available = Array.from(players.keys()).filter(
                  (id) => !members.includes(id) && !otherMembers.includes(id),
                );
                return (
                  <div key={team}>
                    <p className="text-sm">Team {team}</p>
                    <div className="mt-1 flex min-h-9 flex-wrap items-center gap-2">
                      {members.map((id) => (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1.5 rounded-full bg-cyan-600/20 px-3 py-1 text-xs text-cyan-300"
                        >
                          {id}
                          <button
                            type="button"
                            onClick={() => removeFromTeam(team, id)}
                            disabled={isBusy}
                            aria-label={`Remove ${id} from Team ${team}`}
                            className="text-cyan-400 hover:text-cyan-100 disabled:opacity-50"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {members.length === 0 ? <span className="text-xs text-zinc-500">No players yet</span> : null}
                    </div>
                    <select
                      value=""
                      disabled={isBusy || available.length === 0}
                      onChange={(event) => addToTeam(team, event.target.value)}
                      className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm disabled:opacity-50"
                    >
                      <option value="">+ Add player to Team {team}</option>
                      {available.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
              <div className="flex gap-3 text-sm">
                <label className="rounded-lg border border-zinc-700 px-3 py-2">
                  <input type="radio" checked={winner === "A"} onChange={() => setWinner("A")} className="mr-2" />
                  Team A wins
                </label>
                <label className="rounded-lg border border-zinc-700 px-3 py-2">
                  <input type="radio" checked={winner === "B"} onChange={() => setWinner("B")} className="mr-2" />
                  Team B wins
                </label>
              </div>
              <button
                onClick={applyMatch}
                disabled={isBusy}
                className="rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                Apply rating update
              </button>
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
