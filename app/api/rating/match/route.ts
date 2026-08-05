import { NextResponse } from 'next/server';

import { mapToRecord, recordToMap } from '@/lib/map-utils';
import type { MatchResult, PlayerRating } from '@/lib/rating-types';
import { handleRatingServiceError } from '@/lib/server/handle-rating-error';
import { loadMatchStats, recordMatch, upsertPlayers } from '@/lib/server/player-repository';
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

    try {
      const participantIds = [...matchResult.teamA, ...matchResult.teamB];
      const participants = participantIds
        .map((id) => result.players.get(id))
        .filter((player): player is PlayerRating => Boolean(player));
      await upsertPlayers(participants);
      await recordMatch(matchResult);
    } catch (persistError) {
      console.error('Failed to persist match result:', persistError);
      return NextResponse.json({ error: 'Rating computed but failed to save. Please retry.' }, { status: 502 });
    }

    const matchStats = await loadMatchStats();

    return NextResponse.json({
      players: mapToRecord(result.players),
      leaderboard: result.leaderboard,
      matchStats,
    });
  } catch (error) {
    return handleRatingServiceError(error);
  }
}
