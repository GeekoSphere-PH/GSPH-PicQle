import 'server-only';

import { mapToRecord, recordToMap } from '@/lib/map-utils';
import type { LeaderboardEntry, MatchResult, PlayerRating, RoundBuildResult } from '@/lib/rating-types';

const DEFAULT_TIMEOUT_MS = 25_000;

export class RatingServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RatingServiceError';
    this.status = status;
  }
}

function getConfig() {
  const url = process.env.RATING_SERVICE_URL;
  const apiKey = process.env.RATING_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new RatingServiceError(500, 'RATING_SERVICE_URL / RATING_SERVICE_API_KEY are not configured.');
  }
  return { url, apiKey };
}

function resolveTimeoutMs(): number {
  const raw = process.env.RATING_SERVICE_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function callService<T>(path: string, body: unknown): Promise<T> {
  const { url, apiKey } = getConfig();
  const timeoutMs = resolveTimeoutMs();

  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new RatingServiceError(504, 'Rating service timed out — it may be waking up from an idle state.');
    }
    throw new RatingServiceError(502, 'Rating service is unreachable.');
  }

  if (!response.ok) {
    throw new RatingServiceError(502, `Rating service returned ${response.status}.`);
  }

  return (await response.json()) as T;
}

export type JoinResult = {
  player: PlayerRating;
  activePool: string[];
  players: Map<string, PlayerRating>;
  leaderboard: LeaderboardEntry[];
};

export async function joinPlayer(
  playerId: string,
  activePool: string[],
  players: Map<string, PlayerRating>,
  now?: number,
): Promise<JoinResult> {
  const data = await callService<{
    player: PlayerRating;
    activePool: string[];
    players: Record<string, PlayerRating>;
    leaderboard: LeaderboardEntry[];
  }>('/player-join', { playerId, activePool, players: mapToRecord(players), now });

  return {
    player: data.player,
    activePool: data.activePool,
    players: recordToMap(data.players),
    leaderboard: data.leaderboard,
  };
}

export type LeaveResult = {
  activePool: string[];
  players: Map<string, PlayerRating>;
};

export async function leavePlayer(
  playerId: string,
  activePool: string[],
  players: Map<string, PlayerRating>,
): Promise<LeaveResult> {
  const data = await callService<{ activePool: string[]; players: Record<string, PlayerRating> }>(
    '/player-leave',
    { playerId, activePool, players: mapToRecord(players) },
  );

  return { activePool: data.activePool, players: recordToMap(data.players) };
}

export async function buildRound(
  activePool: string[],
  players: Map<string, PlayerRating>,
  courtsAvailable: number,
): Promise<RoundBuildResult> {
  return callService<RoundBuildResult>('/build-round', {
    activePool,
    players: mapToRecord(players),
    courtsAvailable,
  });
}

export type UpdateRatingsResult = {
  players: Map<string, PlayerRating>;
  leaderboard: LeaderboardEntry[];
};

export async function updateMatchRatings(
  matchResult: MatchResult,
  players: Map<string, PlayerRating>,
  now?: number,
): Promise<UpdateRatingsResult> {
  const data = await callService<{ players: Record<string, PlayerRating>; leaderboard: LeaderboardEntry[] }>(
    '/update-ratings',
    { matchResult, players: mapToRecord(players), now },
  );

  return { players: recordToMap(data.players), leaderboard: data.leaderboard };
}

export async function getLeaderboard(players: Map<string, PlayerRating>): Promise<LeaderboardEntry[]> {
  const data = await callService<{ leaderboard: LeaderboardEntry[] }>('/leaderboard', {
    players: mapToRecord(players),
  });
  return data.leaderboard;
}
