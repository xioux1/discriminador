-- Migration: 0013_study_sessions
-- Stores per-session timing data for calibration feedback and adaptive planning.

CREATE TABLE IF NOT EXISTS study_sessions (
  id                 SERIAL  PRIMARY KEY,
  user_id            INTEGER REFERENCES users(id) NOT NULL,
  planned_minutes    NUMERIC(6,2) NOT NULL,
  actual_minutes     NUMERIC(6,2),             -- NULL until session finishes
  planned_card_count INTEGER NOT NULL DEFAULT 0,
  actual_card_count  INTEGER NOT NULL DEFAULT 0,
  energy_level       TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_study_sessions_user
  ON study_sessions(user_id, ended_at DESC NULLS LAST);
