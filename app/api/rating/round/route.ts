import { NextResponse } from 'next/server';

import { recordToMap } from '@/lib/map-utils';
import type { PlayerRating, RoundMode } from '@/lib/rating-types';
import { handleRatingServiceError } from '@/lib/server/handle-rating-error';
import { buildRound } from '@/lib/server/rating-service-client';

export const maxDuration = 30;

type Body = {
  activePool?: string[];
  players?: Record<string, PlayerRating>;
  courtsAvailable?: number;
  roundsWaited?: Record<string, number>;
  mode?: RoundMode;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (
    !Array.isArray(body.activePool) ||
    typeof body.players !== 'object' ||
    body.players === null ||
    typeof body.courtsAvailable !== 'number'
  ) {
    return NextResponse.json({ error: 'activePool, players, and courtsAvailable are required.' }, { status: 400 });
  }

  try {
    const result = await buildRound(
      body.activePool,
      recordToMap(body.players),
      body.courtsAvailable,
      body.roundsWaited ?? {},
      body.mode ?? 'rotation',
    );
    return NextResponse.json(result);
  } catch (error) {
    return handleRatingServiceError(error);
  }
}
