-- Migration: 0018_planner_template
-- Recurring weekly template: blocks that repeat every week by default.

CREATE TABLE IF NOT EXISTS planner_template (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_index  INTEGER NOT NULL CHECK (day_index BETWEEN 0 AND 6),
  slot_time  TEXT    NOT NULL,
  content    TEXT,
  color      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day_index, slot_time)
);
