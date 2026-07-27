export type PlayerRow = {
  id: string;
  name: string;
  mu: number;
  sigma: number;
  volatility: number;
  games_played: number;
  // Epoch milliseconds (bigint column) — not a Postgres timestamp. Matches
  // the rating engine's inactivity-decay math, which operates on this as a
  // plain number.
  last_active_timestamp: number;
  created_at: string;
};

export type MatchRow = {
  id: string;
  team_a: string[];
  team_b: string[];
  winner: 'A' | 'B';
  created_at: string;
};
