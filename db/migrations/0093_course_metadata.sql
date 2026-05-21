CREATE TABLE IF NOT EXISTS subject_lineamientos (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subject            TEXT NOT NULL,
  title              TEXT NOT NULL,
  content            TEXT NOT NULL DEFAULT '',
  lineamiento_type   TEXT NOT NULL DEFAULT 'general',
  due_date           DATE,
  source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  source_note_id     INTEGER REFERENCES subject_class_notes(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subject_lineamientos_user_subject
  ON subject_lineamientos(user_id, subject);

CREATE TABLE IF NOT EXISTS course_metadata_extraction_log (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subject               TEXT NOT NULL,
  source_document_id    UUID REFERENCES documents(id) ON DELETE SET NULL,
  source_note_id        INTEGER REFERENCES subject_class_notes(id) ON DELETE SET NULL,
  extracted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  exam_dates_found      INTEGER NOT NULL DEFAULT 0,
  exam_dates_inserted   INTEGER NOT NULL DEFAULT 0,
  lineamientos_found    INTEGER NOT NULL DEFAULT 0,
  lineamientos_inserted INTEGER NOT NULL DEFAULT 0,
  raw_extraction        JSONB,
  status                TEXT NOT NULL DEFAULT 'completed'
);

CREATE INDEX IF NOT EXISTS idx_metadata_log_user_subject
  ON course_metadata_extraction_log(user_id, subject, extracted_at DESC);
