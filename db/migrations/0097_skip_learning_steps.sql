-- Migration: 0097_skip_learning_steps
ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS skip_learning_steps BOOLEAN NOT NULL DEFAULT FALSE;
