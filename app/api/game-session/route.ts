import { NextResponse } from 'next/server';

import type { BoardState, RoundMode, VersusMode } from '@/lib/rating-types';
import { getActiveGameSession, startGameSession, updateGameSessionBoardState } from '@/lib/server/game-session-repository';

export async function GET() {
  try {
    const session = await getActiveGameSession();
    return NextResponse.json({ session });
  } catch (error) {
    console.error('Failed to load active game session:', error);
    return NextResponse.json({ error: 'Failed to load active game session.' }, { status: 502 });
  }
}

type Body = {
  roundMode?: RoundMode;
  versusMode?: VersusMode;
  courtsAvailable?: number;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.roundMode || !body.versusMode || !body.courtsAvailable) {
    return NextResponse.json({ error: 'roundMode, versusMode, and courtsAvailable are required.' }, { status: 400 });
  }

  try {
    const session = await startGameSession({
      roundMode: body.roundMode,
      versusMode: body.versusMode,
      courtsAvailable: body.courtsAvailable,
    });
    return NextResponse.json({ session });
  } catch (error) {
    console.error('Failed to start game session:', error);
    return NextResponse.json({ error: 'Failed to start game session.' }, { status: 502 });
  }
}

type PatchBody = {
  sessionId?: string;
  boardState?: BoardState;
};

export async function PATCH(request: Request) {
  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.sessionId || !body.boardState) {
    return NextResponse.json({ error: 'sessionId and boardState are required.' }, { status: 400 });
  }

  try {
    await updateGameSessionBoardState(body.sessionId, body.boardState);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to sync game session board state:', error);
    return NextResponse.json({ error: 'Failed to sync game session board state.' }, { status: 502 });
  }
}
