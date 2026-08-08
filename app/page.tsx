"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { mapToRecord, recordToMap } from "@/lib/map-utils";
import type {
  BoardState,
  CourtMatch,
  GameSession,
  LeaderboardEntry,
  MatchStats,
  PlayerRating,
  RoundBuildResult,
  RoundMode,
  VersusMode,
} from "@/lib/rating-types";

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

function formatWaitDuration(ms: number): string {
  if (ms < 60_000) return "<1 min";
  const minutes = Math.round(ms / 60_000);
  return `~${minutes} min${minutes === 1 ? "" : "s"}`;
}

// Medal styling for the top 3 leaderboard cards, keyed by rank index (0 =
// 1st place): a solid tier-colored card, matching crown/rank-number/win%
// tints, and a shadow that gets more prominent the higher the rank.
// Everyone else gets the default dark card with a muted crown and no shadow.
const LEADERBOARD_RANK_TIERS = [
  { card: "bg-[#a3812f]", crown: "text-yellow-200", rankNumber: "text-yellow-200", winPct: "text-yellow-100", shadow: "shadow-2xl shadow-black/70" },
  { card: "bg-zinc-500", crown: "text-zinc-100", rankNumber: "text-zinc-100", winPct: "text-zinc-100", shadow: "shadow-xl shadow-black/60" },
  { card: "bg-[#8a5a34]", crown: "text-amber-100", rankNumber: "text-amber-100", winPct: "text-amber-100", shadow: "shadow-lg shadow-black/50" },
];
const DEFAULT_LEADERBOARD_TIER = { card: "bg-zinc-800", crown: "text-zinc-700", rankNumber: "text-zinc-600", winPct: "text-zinc-100", shadow: "" };

// DiceBear avatars, seeded by player id (name) so each player gets a
// stable, consistent avatar without storing anything ourselves.
function avatarUrl(seed: string): string {
  return `https://api.dicebear.com/10.x/critters/svg?scale=1.3&translateY=10&seed=${encodeURIComponent(seed)}`;
}

function CrownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z" />
    </svg>
  );
}

// A side's displayed win rate is the average of its own players' individual
// win rates (e.g. for a 2-player team, (WR_p1 + WR_p2) / 2) — not the
// team's own win/loss record, which isn't tracked per lineup.
function teamWinRatePct(team: string[], matchStats: Record<string, MatchStats>): number {
  if (team.length === 0) return 0;
  const rates = team.map((id) => {
    const stats = matchStats[id];
    return stats && stats.matchesPlayed > 0 ? (stats.wins / stats.matchesPlayed) * 100 : 0;
  });
  return rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
}

// One side of a status-board match card: overlapping avatars, team name(s),
// and win%. Doubles as the winner-select control — click to select, click
// again elsewhere to change; Confirm result (below the card) applies it.
function TeamMatchBlock({
  team,
  winRatePct,
  isSelected,
  disabled,
  onSelect,
}: {
  team: string[];
  winRatePct: number;
  isSelected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`flex flex-1 flex-col items-center gap-2 rounded-xl p-3 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        isSelected ? "bg-cyan-950/50 ring-2 ring-cyan-500" : "hover:bg-zinc-800/60"
      }`}
    >
      <div className="flex -space-x-3">
        {team.map((id) => (
          <img key={id} src={avatarUrl(id)} alt="" className="h-10 w-10 rounded-full border-2 border-zinc-900 bg-zinc-800" />
        ))}
      </div>
      <p className="text-sm font-semibold text-white">{team.join(" & ")}</p>
      <p className="text-xs font-bold text-orange-400">{Math.round(winRatePct)}% Win</p>
    </button>
  );
}

// A court's current match. Locked (no editing/swapping) once built — the
// only action available is selecting then confirming a winner, which frees
// the court and pulls in the next match. CourtMatch (lib/rating-types.ts)
// is shared with BoardState, which is what actually persists this.
type ActiveMatch = CourtMatch;

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

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
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
  const [matchStats, setMatchStats] = useState<Record<string, MatchStats>>({});
  // "When did this player join the queue" timestamps, keyed by player id.
  // Part of BoardState — synced to game_sessions.board_state alongside
  // activePool/courtSlots/roundsWaited (see the sync effect below) so a
  // refresh mid-session restores it instead of resetting to empty.
  const [queuedAt, setQueuedAt] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
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
  const [showMuSigmaInfo, setShowMuSigmaInfo] = useState(false);
  // Guards the board-sync effect below from firing before the mount
  // restore (fetch of /api/game-session) has had a chance to run — without
  // this, a session found already-active would sync its own just-restored
  // board right back, which is harmless but wasteful.
  const hasHydratedBoardRef = useRef(false);

  // PlayerRating is persistent (Supabase); the leaderboard and all rating
  // math live entirely in the external microservice. On mount, load the
  // real roster from Supabase, then ask the microservice to rank it — this
  // page never computes or stores anything itself.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { players: playerRecord, matchStats: loadedMatchStats } = await getJson<{
          players: Record<string, PlayerRating>;
          matchStats: Record<string, MatchStats>;
        }>("/api/players");
        if (cancelled) return;
        const loadedPlayers = recordToMap(playerRecord);
        setPlayers(loadedPlayers);
        setMatchStats(loadedMatchStats);

        const { leaderboard: loadedLeaderboard } = await postJson<{ leaderboard: LeaderboardEntry[] }>(
          "/api/rating/leaderboard",
          { players: mapToRecord(loadedPlayers) },
        );
        if (!cancelled) setLeaderboard(loadedLeaderboard);

        // If a game is already Started (e.g. another tab, or this page was
        // refreshed mid-session), restore the lock and the settings it
        // locked in instead of showing the defaults — and restore the live
        // board (queue/courts/wait bookkeeping) from board_state, since
        // none of that lives anywhere else once the page reloads.
        const { session } = await getJson<{ session: GameSession | null }>("/api/game-session");
        if (cancelled) return;
        if (session) {
          setGameSession(session);
          setRoundMode(session.roundMode);
          setVersusMode(session.versusMode);
          setCourtsAvailable(session.courtsAvailable);
          const board = session.boardState;
          setCourtSlots((current) => {
            const restored = board?.courtSlots ?? current;
            return restored.length < session.courtsAvailable
              ? [...restored, ...Array<null>(session.courtsAvailable - restored.length).fill(null)]
              : restored;
          });
          setActivePool(board?.activePool ?? []);
          setRoundsWaited(board?.roundsWaited ?? {});
          setQueuedAt(board?.queuedAt ?? {});
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load players.");
      } finally {
        if (!cancelled) hasHydratedBoardRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Mirrors the live queue/court board to the server on every change while
  // a session is active, so a refresh (or a second device) restores exactly
  // where things stood instead of just the locked-in settings (see the
  // mount effect above, which reads it back). Best-effort: a failed sync
  // here doesn't block whatever the user just did, it just risks losing
  // the board on a refresh before the next successful sync.
  useEffect(() => {
    if (!hasHydratedBoardRef.current || !gameSession) return;
    const boardState: BoardState = { activePool, courtSlots, roundsWaited, queuedAt };
    patchJson("/api/game-session", { sessionId: gameSession.id, boardState }).catch((err) => {
      console.error("Failed to sync board state:", err);
    });
  }, [gameSession, activePool, courtSlots, roundsWaited, queuedAt]);

  // Ticks `now` periodically so the live "waiting Xm" / avg queue wait
  // displays advance without needing a user action to re-render.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
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
        setQueuedAt((prev) => ({ ...prev, [id]: Date.now() }));
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
      setQueuedAt((prev) => {
        const next = { ...prev };
        delete next[playerId];
        return next;
      });
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
      const matchedIds = poolToUse.filter((id) => !data.leftover.includes(id));
      if (matchedIds.length > 0) {
        setQueuedAt((prev) => {
          const next = { ...prev };
          for (const id of matchedIds) delete next[id];
          return next;
        });
      }
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
      const paddedSlots =
        courtSlots.length < courtsAvailable
          ? [...courtSlots, ...Array<null>(courtsAvailable - courtSlots.length).fill(null)]
          : courtSlots;
      setCourtSlots(paddedSlots);
      topUpCourts(activePool, { gameSession: data.session, courtSlots: paddedSlots });
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
      setQueuedAt({});
      setRoundsWaited({});
      // Stop clears the whole status board, including any still-in-progress
      // matches — their results are discarded (never confirmed, so nothing
      // was persisted for them) rather than left playable after Stop.
      setCourtSlots([]);
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
      const data = await postJson<{
        players: Record<string, PlayerRating>;
        leaderboard: LeaderboardEntry[];
        matchStats: Record<string, MatchStats>;
      }>(
        "/api/rating/match",
        {
          matchResult: { teamA: match.teamA, teamB: match.teamB, winner: match.selectedWinner },
          players: mapToRecord(players),
          sessionId: gameSession?.id ?? null,
        },
      );
      setPlayers(recordToMap(data.players));
      setLeaderboard(data.leaderboard);
      setMatchStats(data.matchStats);

      // Players return to the queue once their match is done, with a fresh
      // wait-time clock (not the timestamp from before they were matched).
      const returning = [...match.teamA, ...match.teamB].filter((id) => !activePool.includes(id));
      const newPool = [...activePool, ...returning];
      setActivePool(newPool);
      if (returning.length > 0) {
        const rejoinedAt = Date.now();
        setQueuedAt((prev) => {
          const next = { ...prev };
          for (const id of returning) next[id] = rejoinedAt;
          return next;
        });
      }

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
      setMatchStats({});
      setQueuedAt({});
      setCourtSlots(Array<null>(courtsAvailable).fill(null));
      setRoundsWaited({});
      setGameSession(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset data.");
    } finally {
      setIsBusy(false);
    }
  };

  // Live snapshot: average of how long currently-queued players have been
  // waiting right now (not a historical rolling average).
  const currentWaits = activePool
    .map((id) => queuedAt[id])
    .filter((timestamp): timestamp is number => timestamp != null)
    .map((timestamp) => now - timestamp);
  const avgQueueWaitLabel =
    currentWaits.length > 0
      ? formatWaitDuration(currentWaits.reduce((sum, wait) => sum + wait, 0) / currentWaits.length)
      : "—";

  // 1-based leaderboard position per player id, for the queue cards' rank
  // badge. leaderboard is already ranked order (see the Leaderboard section).
  const leaderboardRank: Record<string, number> = {};
  leaderboard.forEach((entry, index) => {
    leaderboardRank[entry.id] = index + 1;
  });

  return (
    <main className="min-h-screen bg-zinc-950 p-6 text-zinc-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-semibold">Pickleball rating queue demo</h1>
            </div>
            <div className="flex shrink-0 gap-2">
              <Link
                href="/history"
                className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium hover:bg-zinc-800"
              >
                History
              </Link>
              <button
                onClick={() => setShowMuSigmaInfo(true)}
                aria-label="What do mu and sigma mean?"
                title="What do mu and sigma mean?"
                className="rounded-lg border border-cyan-800 bg-cyan-950/20 p-2 text-cyan-300 hover:bg-cyan-950/50"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                >
                  <path d="M12 7c-1.5-1.3-3.6-2-6.5-2C4.4 5 3.5 5.2 3 5.3v13.4c.5-.1 1.4-.3 2.5-.3 2.9 0 5 .7 6.5 2" />
                  <path d="M12 7c1.5-1.3 3.6-2 6.5-2 1.1 0 2 .2 2.5.3v13.4c-.5-.1-1.4-.3-2.5-.3-2.9 0-5 .7-6.5 2V7Z" />
                </svg>
              </button>
              <button
                onClick={resetAllData}
                disabled={isBusy}
                aria-label="Reset all data"
                title="Reset all data"
                className="rounded-lg border border-red-800 bg-red-950/40 p-2 text-red-300 hover:bg-red-950/70 disabled:opacity-50"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                >
                  <path d="M3 6h18" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-red-400/80">
            Single-instance warning: this database is shared. Resetting clears every player and match for all connected users, with no undo.
          </p>
          {error ? (
            <p className="mt-4 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</p>
          ) : null}

        </section>

        {showMuSigmaInfo ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setShowMuSigmaInfo(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="What do mu and sigma mean?"
              onClick={(event) => event.stopPropagation()}
              className="w-full max-w-lg rounded-xl border border-cyan-900/60 bg-cyan-950/20 p-4 text-sm text-zinc-300 shadow-xl"
            >
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
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => setShowMuSigmaInfo(false)}
                  className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500"
                >
                  Ok
                </button>
              </div>
            </div>
          </div>
        ) : null}

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
                      <div className="flex min-w-0 items-center gap-3">
                        <img
                          src={avatarUrl(player.id)}
                          alt=""
                          className="h-10 w-10 shrink-0 rounded-full border border-zinc-700 bg-zinc-800"
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{player.id}</p>
                          <p className="text-xs text-zinc-500">
                            Games: {player.gamesPlayed}
                            {inPool && roundsWaited[player.id] ? ` • waiting ${roundsWaited[player.id]} round${roundsWaited[player.id] === 1 ? "" : "s"}` : ""}
                            {inPool && queuedAt[player.id] ? ` • ${formatWaitDuration(now - queuedAt[player.id])}` : ""}
                          </p>
                        </div>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${inPool ? "bg-emerald-600/20 text-emerald-400" : "bg-zinc-800 text-zinc-300"}`}>
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
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-xl font-semibold">Leaderboard</h2>
              <p className="text-xs text-zinc-500">Avg queue wait: {avgQueueWaitLabel}</p>
            </div>
            <div className="mt-4 space-y-3">
              {leaderboard.map((player, rank) => {
                const stats = matchStats[player.id];
                const wins = stats?.wins ?? 0;
                const losses = stats ? stats.matchesPlayed - stats.wins : 0;
                const winRateLabel = stats && stats.matchesPlayed > 0 ? `${Math.round((wins / stats.matchesPlayed) * 100)}%` : "—";
                const tier = LEADERBOARD_RANK_TIERS[rank] ?? DEFAULT_LEADERBOARD_TIER;
                return (
                  <div key={player.id} className={`font-coda flex items-center gap-4 rounded-2xl p-4 ${tier.card} ${tier.shadow}`}>
                    <img
                      src={avatarUrl(player.id)}
                      alt=""
                      className="h-14 w-14 shrink-0 rounded-full border-2 border-black/20 bg-zinc-800"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-lg text-white">{player.id}</p>
                      <div className="mt-1.5 flex gap-4">
                        <div>
                          <p className="text-base text-white">{player.gamesPlayed}</p>
                          <p className="text-[10px] uppercase tracking-wide text-white/60">GP</p>
                        </div>
                        <div>
                          <p className="text-base text-white">{wins}</p>
                          <p className="text-[10px] uppercase tracking-wide text-white/60">Win</p>
                        </div>
                        <div>
                          <p className="text-base text-white">{losses}</p>
                          <p className="text-[10px] uppercase tracking-wide text-white/60">Loss</p>
                        </div>
                        <div>
                          <p className={`text-base font-bold ${tier.winPct}`}>{winRateLabel}</p>
                          <p className="text-[10px] uppercase tracking-wide text-white/60">Win %</p>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-center gap-1">
                      {rank < 3 ? <CrownIcon className={`h-5 w-5 ${tier.crown}`} /> : null}
                      <span className={`text-3xl font-black ${tier.rankNumber}`}>{rank + 1}</span>
                    </div>
                  </div>
                );
              })}
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
            <div className="mt-3 grid grid-cols-3 divide-x divide-zinc-700 overflow-hidden rounded-lg border border-zinc-700 text-sm">
              <button
                type="button"
                onClick={() => setRoundMode("rotation")}
                disabled={isBusy || gameSession !== null}
                className={`px-3 py-2 text-center font-medium transition-colors disabled:opacity-50 ${
                  roundMode === "rotation" ? "bg-cyan-600 text-white" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                Fair rotation
              </button>
              <button
                type="button"
                onClick={() => setRoundMode("rating")}
                disabled={isBusy || gameSession !== null}
                className={`px-3 py-2 text-center font-medium transition-colors disabled:opacity-50 ${
                  roundMode === "rating" ? "bg-cyan-600 text-white" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                Best rating match
              </button>
              <button
                type="button"
                onClick={() => setRoundMode("strictRotationBestMatch")}
                disabled={isBusy || gameSession !== null}
                className={`px-3 py-2 text-center font-medium transition-colors disabled:opacity-50 ${
                  roundMode === "strictRotationBestMatch" ? "bg-cyan-600 text-white" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                Strict rotation + Best rating match
              </button>
            </div>

            <p className="mt-4 text-sm text-zinc-400">{VERSUS_MODE_EXPLAINERS[versusMode]}</p>
            <div className="mt-3 grid grid-cols-2 divide-x divide-zinc-700 overflow-hidden rounded-lg border border-zinc-700 text-sm">
              <button
                type="button"
                onClick={() => changeVersusMode("doubles")}
                disabled={isBusy || gameSession !== null}
                className={`px-4 py-2 text-center font-medium transition-colors disabled:opacity-50 ${
                  versusMode === "doubles" ? "bg-cyan-600 text-white" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                Doubles
              </button>
              <button
                type="button"
                onClick={() => changeVersusMode("singles")}
                disabled={isBusy || gameSession !== null}
                className={`px-4 py-2 text-center font-medium transition-colors disabled:opacity-50 ${
                  versusMode === "singles" ? "bg-cyan-600 text-white" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                Singles
              </button>
            </div>

            <div className="mt-8 mb-4 flex w-full items-center gap-3 text-sm">
              <span className="shrink-0 text-zinc-400">Courts</span>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={courtsAvailable}
                onChange={(event) => changeCourtsAvailable(Number(event.target.value))}
                disabled={isBusy || gameSession !== null}
                className="h-2 flex-1 cursor-pointer rounded-full accent-cyan-500 disabled:cursor-not-allowed disabled:opacity-50 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-zinc-950 [&::-moz-range-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-zinc-950 [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:shadow-md"
              />
              <span className="w-4 shrink-0 text-right font-semibold text-cyan-400 tabular-nums">{courtsAvailable}</span>
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
              {activePool.length === 0 ? (
                <p className="mt-2 font-medium text-zinc-500">(empty)</p>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {activePool.map((id, index) => (
                    <div key={id} className="flex items-center gap-2">
                      {index > 0 ? <span className="text-zinc-600">→</span> : null}
                      <div className="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900 py-1 pr-3 pl-1">
                        <img src={avatarUrl(id)} alt="" className="h-6 w-6 rounded-full bg-zinc-800" />
                        <span className="text-xs font-medium text-white">{id}</span>
                        {leaderboardRank[id] ? (
                          <span className="text-[10px] font-bold text-cyan-400">#{leaderboardRank[id]}</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
                    <div className="rounded-2xl bg-zinc-950 p-4">
                      <div className="flex items-center gap-3">
                        <TeamMatchBlock
                          team={match.teamA}
                          winRatePct={teamWinRatePct(match.teamA, matchStats)}
                          isSelected={match.selectedWinner === "A"}
                          disabled={isBusy}
                          onSelect={() => selectWinner(match.id, "A")}
                        />
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black text-[11px] font-bold text-white">
                          vs
                        </span>
                        <TeamMatchBlock
                          team={match.teamB}
                          winRatePct={teamWinRatePct(match.teamB, matchStats)}
                          isSelected={match.selectedWinner === "B"}
                          disabled={isBusy}
                          onSelect={() => selectWinner(match.id, "B")}
                        />
                      </div>
                      <button
                        onClick={() => confirmMatch(match)}
                        disabled={isBusy || !match.selectedWinner}
                        className="mt-3 w-full rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
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

      <div className="fixed bottom-4 right-4 z-50 flex items-center rounded-full bg-[#F44336] px-3 py-1.5 text-xs font-semibold text-white shadow-[0_2px_8px_rgba(0,0,0,0.4)]">
        Live commit: <span className="ml-1.5 font-mono">{COMMIT_SHA_SHORT}</span>
      </div>
    </main>
  );
}
