CREATE TABLE IF NOT EXISTS user_settings (
  user_id                   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_planning_enabled  BOOLEAN NOT NULL DEFAULT true,
  gratitude_enabled         BOOLEAN NOT NULL DEFAULT true,
  time_restriction_enabled  BOOLEAN NOT NULL DEFAULT true,
  updated_at                TIMESTAMPTZ DEFAULT now()
);
