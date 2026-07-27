export type PlayerRating = {
  id: string;
  mu: number;
  sigma: number;
  volatility: number;
  gamesPlayed: number;
  lastActiveTimestamp: number;
};

export type MatchResult = {
  teamA: string[];
  teamB: string[];
  winner: 'A' | 'B';
};

export type RoundBuildResult = {
  matches: MatchResult[];
  leftover: string[];
  roundsWaited: Record<string, number>;
};

export type LeaderboardEntry = PlayerRating & {
  conservativeRating: number;
};

// "rotation": whoever's waited the most rounds gets a guaranteed spot next,
// even if that makes the match less balanced by rating. "rating": always
// pick the closest-by-rating group (the original behavior). roundsWaited is
// tracked either way, so switching modes mid-session doesn't lose the count.
export type RoundMode = "rating" | "rotation";
