-- Subject-level cap for introducing new cards per day (Anki-like release control)
ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS daily_new_cards_limit INTEGER
  CHECK (daily_new_cards_limit IS NULL OR daily_new_cards_limit >= 0);
