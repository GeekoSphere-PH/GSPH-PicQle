export type PlayerRow = {
  id: string;
  name: string;
  mu: number;
  sigma: number;
  volatility: number;
  games_played: number;
  last_active_timestamp: string;
  created_at: string;
};

export type MatchRow = {
  id: string;
  team_a: string[];
  team_b: string[];
  winner: 'A' | 'B';
  created_at: string;
};
