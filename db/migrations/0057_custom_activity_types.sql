-- User-defined activity types that persist across sessions
CREATE TABLE custom_activity_types (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  label      TEXT NOT NULL,
  slug       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#888888',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, slug)
);

-- Remove the hardcoded CHECK constraint so custom slugs can be stored
ALTER TABLE manual_activity_sessions
  DROP CONSTRAINT IF EXISTS manual_activity_sessions_activity_type_check;
