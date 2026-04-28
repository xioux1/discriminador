-- Manual activity sessions: tracks user-initiated activities (clase, contenido, etc.)
-- that don't go through the app's automatic study tracking.
CREATE TABLE IF NOT EXISTS manual_activity_sessions (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  activity_type TEXT    NOT NULL CHECK (activity_type IN ('clase', 'contenido', 'estudio_offline', 'reunion', 'otro')),
  subject       TEXT,
  description   TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manual_activity_sessions_user_started
  ON manual_activity_sessions(user_id, started_at DESC);
