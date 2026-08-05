import { NextResponse } from 'next/server';

import { mapToRecord } from '@/lib/map-utils';
import { deleteAllGameSessions } from '@/lib/server/game-session-repository';
import { deleteAllData, loadAllPlayers, loadMatchStats } from '@/lib/server/player-repository';

export async function GET() {
  try {
    const players = await loadAllPlayers();
    const matchStats = await loadMatchStats();
    return NextResponse.json({ players: mapToRecord(players), matchStats });
  } catch (error) {
    console.error('Failed to load players from Supabase:', error);
    return NextResponse.json({ error: 'Failed to load players.' }, { status: 502 });
  }
}

// Wipes every player and match row for every connected user — see the
// confirmation copy in app/page.tsx before touching this.
export async function DELETE() {
  try {
    await deleteAllData();
    await deleteAllGameSessions();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to reset players/matches in Supabase:', error);
    return NextResponse.json({ error: 'Failed to reset data.' }, { status: 502 });
  }
}
