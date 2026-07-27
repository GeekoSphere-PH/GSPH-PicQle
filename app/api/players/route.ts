import { NextResponse } from 'next/server';

import { mapToRecord } from '@/lib/map-utils';
import { loadAllPlayers } from '@/lib/server/player-repository';

export async function GET() {
  try {
    const players = await loadAllPlayers();
    return NextResponse.json({ players: mapToRecord(players) });
  } catch (error) {
    console.error('Failed to load players from Supabase:', error);
    return NextResponse.json({ error: 'Failed to load players.' }, { status: 502 });
  }
}
