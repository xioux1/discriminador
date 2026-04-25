-- Migration: 0043_session_plan_logs
-- Adds per-subject configurable retention floor and agent reasoning logs.

ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS retention_floor NUMERIC(4,2) NOT NULL DEFAULT 0.75
    CHECK (retention_floor BETWEEN 0.50 AND 0.99);

CREATE TABLE IF NOT EXISTS session_plan_logs (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  available_minutes INTEGER NOT NULL,
  energy_level     TEXT    NOT NULL,
  subject_filter   TEXT,
  planned_count    INTEGER NOT NULL DEFAULT 0,
  deferred_count   INTEGER NOT NULL DEFAULT 0,
  forced_count     INTEGER NOT NULL DEFAULT 0,
  agent_reasoning  TEXT    NOT NULL,
  card_decisions   JSONB   NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_plan_logs_user
  ON session_plan_logs(user_id, created_at DESC);
