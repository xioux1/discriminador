-- Multiple exam dates per subject (1er Parcial, 2do Parcial, Final, etc.)
-- Replaces the single exam_date/exam_type columns on subject_configs.
CREATE TABLE IF NOT EXISTS subject_exam_dates (
  id         SERIAL  PRIMARY KEY,
  subject    TEXT    NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  label      TEXT    NOT NULL DEFAULT 'Parcial',
  exam_date  DATE    NOT NULL,
  exam_type  TEXT    NOT NULL DEFAULT 'parcial', -- 'parcial' | 'final'
  scope_pct  INTEGER NOT NULL DEFAULT 50 CHECK (scope_pct BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subject_exam_dates_user
  ON subject_exam_dates(user_id, subject, exam_date);

-- Migrate existing single exam_date rows into the new table (best-effort)
INSERT INTO subject_exam_dates (subject, user_id, label, exam_date, exam_type, scope_pct)
SELECT
  sc.subject,
  sc.user_id,
  CASE WHEN sc.exam_type = 'final' THEN 'Final' ELSE '1er Parcial' END,
  sc.exam_date,
  COALESCE(sc.exam_type, 'parcial'),
  50
FROM subject_configs sc
WHERE sc.exam_date IS NOT NULL
ON CONFLICT DO NOTHING;
