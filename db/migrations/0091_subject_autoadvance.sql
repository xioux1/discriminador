-- Migration: 0091_subject_autoadvance
ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS autoadvance_enabled         BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS autoadvance_question_seconds NUMERIC(6,1),
  ADD COLUMN IF NOT EXISTS autoadvance_answer_seconds   NUMERIC(6,1),
  ADD COLUMN IF NOT EXISTS autoadvance_answer_action    TEXT        NOT NULL DEFAULT 'again';
