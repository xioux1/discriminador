-- Migration: 0020_user_notes
-- Global quick-notes scratchpad per user, not tied to any subject or card.

CREATE TABLE IF NOT EXISTS user_notes (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) NOT NULL UNIQUE,
  content    TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_notes_user ON user_notes(user_id);
