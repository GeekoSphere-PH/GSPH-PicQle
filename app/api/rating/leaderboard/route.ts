import { NextResponse } from 'next/server';

import { recordToMap } from '@/lib/map-utils';
import type { PlayerRating } from '@/lib/rating-types';
import { handleRatingServiceError } from '@/lib/server/handle-rating-error';
import { getLeaderboard } from '@/lib/server/rating-service-client';

export const maxDuration = 30;

type Body = {
  players?: Record<string, PlayerRating>;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (typeof body.players !== 'object' || body.players === null) {
    return NextResponse.json({ error: 'players is required.' }, { status: 400 });
  }

  try {
    const leaderboard = await getLeaderboard(recordToMap(body.players));
    return NextResponse.json({ leaderboard });
  } catch (error) {
    return handleRatingServiceError(error);
  }
}
