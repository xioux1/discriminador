-- Migration: 0006_activity_log
-- Activity log for heatmap and stats. Receives one row per review/evaluation.
-- Also adds avg_response_time_ms to cards for performance tracking.

CREATE TABLE IF NOT EXISTS activity_log (
  id               SERIAL PRIMARY KEY,
  logged_date      DATE        NOT NULL DEFAULT CURRENT_DATE,
  activity_type    TEXT        NOT NULL DEFAULT 'study', -- 'evaluate' | 'study'
  subject          TEXT,
  grade            TEXT,                                 -- pass | fail | review
  response_time_ms INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_log_date_idx ON activity_log(logged_date DESC);

ALTER TABLE cards ADD COLUMN IF NOT EXISTS avg_response_time_ms INT;
