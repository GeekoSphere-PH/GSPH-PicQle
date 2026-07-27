import { NextResponse } from 'next/server';

import { mapToRecord, recordToMap } from '@/lib/map-utils';
import type { PlayerRating } from '@/lib/rating-types';
import { handleRatingServiceError } from '@/lib/server/handle-rating-error';
import { upsertPlayer } from '@/lib/server/player-repository';
import { joinPlayer } from '@/lib/server/rating-service-client';

export const maxDuration = 30;

type Body = {
  playerId?: string;
  activePool?: string[];
  players?: Record<string, PlayerRating>;
  now?: number;
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
    const result = await joinPlayer(body.playerId, body.activePool, recordToMap(body.players), body.now);

    try {
      await upsertPlayer(result.player);
    } catch (persistError) {
      console.error('Failed to persist player join:', persistError);
      return NextResponse.json({ error: 'Rating computed but failed to save. Please retry.' }, { status: 502 });
    }

    return NextResponse.json({
      player: result.player,
      activePool: result.activePool,
      players: mapToRecord(result.players),
      leaderboard: result.leaderboard,
    });
  } catch (error) {
    return handleRatingServiceError(error);
  }
}
