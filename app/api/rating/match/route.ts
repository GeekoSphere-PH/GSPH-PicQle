import { NextResponse } from 'next/server';

import { mapToRecord, recordToMap } from '@/lib/map-utils';
import type { MatchResult, PlayerRating } from '@/lib/rating-types';
import { handleRatingServiceError } from '@/lib/server/handle-rating-error';
import { updateMatchRatings } from '@/lib/server/rating-service-client';

export const maxDuration = 30;

type Body = {
  matchResult?: MatchResult;
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

  const matchResult = body.matchResult;
  if (
    !matchResult ||
    !Array.isArray(matchResult.teamA) ||
    !Array.isArray(matchResult.teamB) ||
    (matchResult.winner !== 'A' && matchResult.winner !== 'B') ||
    typeof body.players !== 'object' ||
    body.players === null
  ) {
    return NextResponse.json({ error: 'matchResult and players are required.' }, { status: 400 });
  }

  try {
    const result = await updateMatchRatings(matchResult, recordToMap(body.players), body.now);
    return NextResponse.json({
      players: mapToRecord(result.players),
      leaderboard: result.leaderboard,
    });
  } catch (error) {
    return handleRatingServiceError(error);
  }
}
