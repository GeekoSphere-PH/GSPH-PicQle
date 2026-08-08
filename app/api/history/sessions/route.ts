import { NextResponse } from 'next/server';

import { listPastGameSessions } from '@/lib/server/game-session-repository';

export async function GET() {
  try {
    const sessions = await listPastGameSessions();
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error('Failed to load past game sessions:', error);
    return NextResponse.json({ error: 'Failed to load past game sessions.' }, { status: 502 });
  }
}
