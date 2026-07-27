import 'server-only';

import { NextResponse } from 'next/server';

import { RatingServiceError } from '@/lib/server/rating-service-client';

export function handleRatingServiceError(error: unknown) {
  if (error instanceof RatingServiceError) {
    if (error.status === 504) {
      return NextResponse.json(
        { error: 'Rating service timed out — it may be waking up, please try again in a moment.' },
        { status: 504 },
      );
    }
    console.error('Rating service error:', error.message);
    return NextResponse.json({ error: 'Rating service is unavailable.' }, { status: 502 });
  }

  console.error('Unexpected error calling rating service:', error);
  return NextResponse.json({ error: 'Unexpected error.' }, { status: 500 });
}
