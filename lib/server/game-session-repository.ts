import 'server-only';

import type { GameSessionRow } from '@/lib/supabase/types';
import type { GameSession, RoundMode, VersusMode } from '@/lib/rating-types';
import { getSupabaseAdminClient } from '@/lib/server/supabase-admin';

const SESSION_COLUMNS = 'id, round_mode, versus_mode, courts_available, started_at, ended_at';

function rowToSession(
  row: Pick<GameSessionRow, 'id' | 'round_mode' | 'versus_mode' | 'courts_available' | 'started_at' | 'ended_at'>,
): GameSession {
  return {
    id: row.id,
    roundMode: row.round_mode as RoundMode,
    versusMode: row.versus_mode as VersusMode,
    courtsAvailable: row.courts_available,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

// At most one session should have ended_at = null at a time (enforced by
// the app, not a DB constraint) — the most recently started one wins if
// that's ever violated.
export async function getActiveGameSession(): Promise<GameSession | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('game_sessions')
    .select(SESSION_COLUMNS)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load active game session: ${error.message}`);
  }

  return data ? rowToSession(data) : null;
}

export async function startGameSession(settings: {
  roundMode: RoundMode;
  versusMode: VersusMode;
  courtsAvailable: number;
}): Promise<GameSession> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('game_sessions')
    .insert({
      round_mode: settings.roundMode,
      versus_mode: settings.versusMode,
      courts_available: settings.courtsAvailable,
    })
    .select(SESSION_COLUMNS)
    .single();

  if (error) {
    throw new Error(`Failed to start game session: ${error.message}`);
  }

  return rowToSession(data);
}

export async function stopGameSession(id: string): Promise<GameSession> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from('game_sessions')
    .update({ ended_at: new Date().toISOString() })
    .eq('id', id)
    .is('ended_at', null)
    .select(SESSION_COLUMNS)
    .single();

  if (error) {
    throw new Error(`Failed to stop game session: ${error.message}`);
  }

  return rowToSession(data);
}

// Wipes every session row. Mirrors player-repository.ts's deleteAllData,
// called alongside it from the "Reset all data" flow.
export async function deleteAllGameSessions(): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from('game_sessions').delete().not('id', 'is', null);

  if (error) {
    throw new Error(`Failed to delete game sessions: ${error.message}`);
  }
}
