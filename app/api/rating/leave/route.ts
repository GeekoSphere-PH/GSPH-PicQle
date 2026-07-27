import { NextResponse } from 'next/server';

import { mapToRecord, recordToMap } from '@/lib/map-utils';
import type { PlayerRating } from '@/lib/rating-types';
import { handleRatingServiceError } from '@/lib/server/handle-rating-error';
import { leavePlayer } from '@/lib/server/rating-service-client';

export const maxDuration = 30;

type Body = {
  playerId?: string;
  activePool?: string[];
  players?: Record<string, PlayerRating>;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.playerId || !Array.isArray(body.activePool) || typeof body.players !== 'object' || body.players === null) {
    return NextResponse.json({ error: 'playerId, activePool, and players are required.' }, { status: 400 });
  }

  try {
    const result = await leavePlayer(body.playerId, body.activePool, recordToMap(body.players));
    return NextResponse.json({
      activePool: result.activePool,
      players: mapToRecord(result.players),
    });
  } catch (error) {
    return handleRatingServiceError(error);
  }
}
