import { NextResponse } from 'next/server';

import { stopGameSession } from '@/lib/server/game-session-repository';

type Body = {
  sessionId?: string;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.sessionId) {
    return NextResponse.json({ error: 'sessionId is required.' }, { status: 400 });
  }

  try {
    const session = await stopGameSession(body.sessionId);
    return NextResponse.json({ session });
  } catch (error) {
    console.error('Failed to stop game session:', error);
    return NextResponse.json({ error: 'Failed to stop game session.' }, { status: 502 });
  }
}
