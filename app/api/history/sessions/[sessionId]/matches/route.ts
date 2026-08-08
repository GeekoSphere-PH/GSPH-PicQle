import { NextResponse } from 'next/server';

import { listMatchesForSession } from '@/lib/server/player-repository';

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;

  try {
    const matches = await listMatchesForSession(sessionId);
    return NextResponse.json({ matches });
  } catch (error) {
    console.error(`Failed to load matches for session "${sessionId}":`, error);
    return NextResponse.json({ error: 'Failed to load matches for session.' }, { status: 502 });
  }
}
