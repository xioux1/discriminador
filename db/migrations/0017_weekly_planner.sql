-- Migration: 0017_weekly_planner
-- Weekly planner: 30-minute time slots per day, per user, per week.

CREATE TABLE IF NOT EXISTS weekly_planner (
  id          SERIAL      PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start  DATE        NOT NULL,          -- always the Sunday of the week
  day_index   INTEGER     NOT NULL CHECK (day_index BETWEEN 0 AND 6), -- 0=Sun
  slot_time   TEXT        NOT NULL,          -- 'HH:MM' e.g. '06:00', '14:30'
  content     TEXT,
  color       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start, day_index, slot_time)
);

CREATE INDEX IF NOT EXISTS idx_weekly_planner_user_week
  ON weekly_planner (user_id, week_start);
