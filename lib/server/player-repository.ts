import 'server-only';

import type { MatchRow, PlayerRow } from '@/lib/supabase/types';
import type { MatchResult, PlayerRating } from '@/lib/rating-types';
import { getSupabaseAdminClient } from '@/lib/server/supabase-admin';

// Maps between the app's single string PlayerRating.id (used everywhere:
// Map keys, activePool, teamA/teamB, the rating microservice's playerId)
// and a `players` row. The DB's `id` is an internal uuid the app never
// needs to know about — `name` (unique) is the app's id, and is the only
// column this layer reads/writes it against.

function rowToPlayer(row: Pick<PlayerRow, 'name' | 'mu' | 'sigma' | 'volatility' | 'games_played' | 'last_active_timestamp'>): PlayerRating {
  return {
    id: row.name,
    mu: row.mu,
    sigma: row.sigma,
    volatility: row.volatility,
    gamesPlayed: row.games_played,
    lastActiveTimestamp: row.last_active_timestamp,
  };
}

export async function loadAllPlayers(): Promise<Map<string, PlayerRating>> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('players')
    .select('name, mu, sigma, volatility, games_played, last_active_timestamp');

  if (error) {
    throw new Error(`Failed to load players: ${error.message}`);
  }

  return new Map((data ?? []).map((row) => [row.name, rowToPlayer(row)]));
}

export async function upsertPlayer(player: PlayerRating): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from('players').upsert(
    {
      name: player.id,
      mu: player.mu,
      sigma: player.sigma,
      volatility: player.volatility,
      games_played: player.gamesPlayed,
      // last_active_timestamp is a bigint column — it rejects fractional
      // values, which a caller could in principle produce (e.g. a
      // millisecond-precision float from an upstream clock).
      last_active_timestamp: Math.round(player.lastActiveTimestamp),
    },
    { onConflict: 'name' },
  );

  if (error) {
    throw new Error(`Failed to save player "${player.id}": ${error.message}`);
  }
}

export async function upsertPlayers(players: PlayerRating[]): Promise<void> {
  await Promise.all(players.map((player) => upsertPlayer(player)));
}

export async function recordMatch(match: MatchResult): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from('matches').insert({
    team_a: match.teamA,
    team_b: match.teamB,
    winner: match.winner,
  } satisfies Pick<MatchRow, 'team_a' | 'team_b' | 'winner'>);

  if (error) {
    throw new Error(`Failed to record match: ${error.message}`);
  }
}
