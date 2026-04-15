-- Binary check log.
-- Records every negative result from the in-session binary verifier.
-- Feeds the check-fail penalty in the scheduler and micro-card generation.
CREATE TABLE IF NOT EXISTS binary_check_log (
  id          SERIAL PRIMARY KEY,
  user_id     INT  REFERENCES users(id)  ON DELETE CASCADE,
  card_id     INT  REFERENCES cards(id)  ON DELETE CASCADE,
  subject     TEXT,
  user_answer TEXT,
  result      TEXT NOT NULL CHECK (result IN ('ok', 'error')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS binary_check_log_card_user_idx
  ON binary_check_log (card_id, user_id);
