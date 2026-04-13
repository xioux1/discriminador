-- Migration 0032: gratitude log — user registers something they're grateful for before each study session
CREATE TABLE IF NOT EXISTS gratitude_log (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  llm_response TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gratitude_log_user
  ON gratitude_log (user_id, created_at DESC);
