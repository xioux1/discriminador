CREATE TABLE IF NOT EXISTS sql_coding_standards (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  rules       JSONB NOT NULL DEFAULT '[]',
  source_text TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sql_standards_user_subject
  ON sql_coding_standards(user_id, subject);
