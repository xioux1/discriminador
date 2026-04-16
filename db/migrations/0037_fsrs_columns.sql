-- FSRS state columns for cards
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS stability  FLOAT,
  ADD COLUMN IF NOT EXISTS difficulty FLOAT;

-- FSRS state columns for micro_cards (also add missing last_reviewed_at)
ALTER TABLE micro_cards
  ADD COLUMN IF NOT EXISTS stability       FLOAT,
  ADD COLUMN IF NOT EXISTS difficulty      FLOAT,
  ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ;

-- Backfill cards: stability = interval (best estimate), difficulty from ease_factor (inverted)
UPDATE cards SET
  stability  = COALESCE(interval_days, 1),
  difficulty = GREATEST(1, LEAST(10, 10 - ((COALESCE(ease_factor, 2.5) - 1.3) / 1.7 * 9)))
WHERE stability IS NULL;

-- Backfill micro_cards
UPDATE micro_cards SET
  stability  = COALESCE(interval_days, 1),
  difficulty = GREATEST(1, LEAST(10, 10 - ((COALESCE(ease_factor, 2.0) - 1.3) / 1.7 * 9)))
WHERE stability IS NULL;

-- Set column defaults after backfill (W[2] = 3.1262 is stability for grade=good)
ALTER TABLE cards
  ALTER COLUMN stability  SET DEFAULT 3.1262,
  ALTER COLUMN difficulty SET DEFAULT 5.0;

ALTER TABLE micro_cards
  ALTER COLUMN stability  SET DEFAULT 3.1262,
  ALTER COLUMN difficulty SET DEFAULT 5.0;
