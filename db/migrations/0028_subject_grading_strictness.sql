-- Migration 0028: add grading_strictness to subject_configs
-- 0 = very lenient, 5 = standard (default), 10 = maximum strictness
ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS grading_strictness INTEGER NOT NULL DEFAULT 5
    CHECK (grading_strictness >= 0 AND grading_strictness <= 10);
