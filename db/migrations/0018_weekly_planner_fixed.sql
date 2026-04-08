-- Migration: 0018_weekly_planner_fixed
-- Adds recurring weekly planner blocks that apply to every week.

CREATE TABLE IF NOT EXISTS weekly_planner_fixed (
  id          SERIAL      PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_index   INTEGER     NOT NULL CHECK (day_index BETWEEN 0 AND 6), -- 0=Sun
  slot_time   TEXT        NOT NULL,          -- 'HH:MM' e.g. '06:00', '14:30'
  content     TEXT,
  color       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, day_index, slot_time)
);

CREATE INDEX IF NOT EXISTS idx_weekly_planner_fixed_user
  ON weekly_planner_fixed (user_id, day_index, slot_time);
