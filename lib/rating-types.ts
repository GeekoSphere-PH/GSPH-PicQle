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
};

export type LeaderboardEntry = PlayerRating & {
  conservativeRating: number;
};
