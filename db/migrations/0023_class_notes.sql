-- Migration: 0023_class_notes
-- Individual class notes entries per subject, replacing the single notes_text blob.

CREATE TABLE IF NOT EXISTS subject_class_notes (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) NOT NULL,
  subject    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subject_class_notes_user_subject
  ON subject_class_notes(user_id, subject, position);
