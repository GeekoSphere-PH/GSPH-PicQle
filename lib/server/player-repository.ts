import 'server-only';

import type { MatchRow, PlayerRow } from '@/lib/supabase/types';
import type { MatchResult, MatchStats, PlayerRating } from '@/lib/rating-types';
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

// Aggregates the write-only `matches` table into per-player win/loss counts.
// Nothing else reads this table back today, so there's no incremental
// counter to reuse — a full scan is simplest at this table's demo scale.
export async function loadMatchStats(): Promise<Record<string, MatchStats>> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.from('matches').select('team_a, team_b, winner');

  if (error) {
    throw new Error(`Failed to load match stats: ${error.message}`);
  }

  const stats: Record<string, MatchStats> = {};
  const bump = (id: string, won: boolean) => {
    const entry = stats[id] ?? (stats[id] = { wins: 0, matchesPlayed: 0 });
    entry.matchesPlayed += 1;
    if (won) entry.wins += 1;
  };

  for (const row of data ?? []) {
    for (const id of row.team_a) bump(id, row.winner === 'A');
    for (const id of row.team_b) bump(id, row.winner === 'B');
  }

  return stats;
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

// Wipes every player and match row. Mirrors supabase/reset_data.sql, exposed
// here so the demo UI can trigger the same thing without the SQL editor.
export async function deleteAllData(): Promise<void> {
  const supabase = getSupabaseAdminClient();

  const [playersResult, matchesResult] = await Promise.all([
    supabase.from('players').delete().not('id', 'is', null),
    supabase.from('matches').delete().not('id', 'is', null),
  ]);

  if (playersResult.error) {
    throw new Error(`Failed to delete players: ${playersResult.error.message}`);
  }
  if (matchesResult.error) {
    throw new Error(`Failed to delete matches: ${matchesResult.error.message}`);
  }
}
