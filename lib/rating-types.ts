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

export type MatchStats = {
  wins: number;
  matchesPlayed: number;
};

// "rotation": whoever's waited the most rounds gets a guaranteed spot next,
// even if that makes the match less balanced by rating. "rating": always
// pick the closest-by-rating group (the original behavior).
// "strictRotationBestMatch": same due-up guarantee as "rotation", but teams
// within that fixed due-up set are grouped to minimize the total rating gap
// across all courts, rather than rotation's simple consecutive-block
// slicing. roundsWaited is tracked either way, so switching modes
// mid-session doesn't lose the count.
// NOTE: this literal must be kept in sync by hand with RoundMode in
// pickleballq-rating-service/app/models.py -- no shared codegen exists.
export type RoundMode = "rating" | "rotation" | "strictRotationBestMatch";

// "doubles": 2v2, 4 players per match (default, existing behavior).
// "singles": 1v1, 2 players per match.
// NOTE: this literal must be kept in sync by hand with VersusMode in
// pickleballq-rating-service/app/models.py -- no shared codegen exists.
export type VersusMode = "singles" | "doubles";

// A court's current match. `id` is client-only (the API's MatchResult has
// none) but round-trips through BoardState so a restored board keeps
// stable per-court identity.
export type CourtMatch = {
  id: string;
  teamA: string[];
  teamB: string[];
  selectedWinner?: "A" | "B";
};

// The live queue/court board for an active session: who's queued, what's on
// each court, and rotation/wait bookkeeping. Persisted on game_sessions so a
// page refresh (or a second device) restores exactly where things stood,
// not just the locked-in round/versus/courts settings.
export type BoardState = {
  activePool: string[];
  courtSlots: (CourtMatch | null)[];
  roundsWaited: Record<string, number>;
  queuedAt: Record<string, number>;
};

// A "game profile setting" session: Start locks in roundMode/versusMode/
// courtsAvailable and records startedAt; Stop records endedAt and unlocks
// them again. endedAt is null while the session is active. boardState is
// null until the first board sync after Start.
export type GameSession = {
  id: string;
  roundMode: RoundMode;
  versusMode: VersusMode;
  courtsAvailable: number;
  startedAt: string;
  endedAt: string | null;
  boardState: BoardState | null;
};
