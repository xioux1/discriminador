-- Custom calendar events for the monthly planner view
CREATE TABLE IF NOT EXISTS planner_calendar_events (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  title      TEXT NOT NULL,
  event_date DATE NOT NULL,
  color      TEXT NOT NULL DEFAULT '#c9daf8',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planner_calendar_events_user_date
  ON planner_calendar_events(user_id, event_date);
