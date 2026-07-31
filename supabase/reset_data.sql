-- Clears all player ratings and match history.
-- Does NOT drop tables, columns, constraints, or RLS policies -- run
-- supabase/schema.sql again if you need the schema itself recreated.
--
-- WARNING: irreversible. This permanently deletes every row in both
-- tables. Run in the Supabase SQL editor only when you actually mean to
-- wipe the data (e.g. clearing out test rows before going live).

truncate table public.matches, public.players, public.game_sessions;
