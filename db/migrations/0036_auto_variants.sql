-- Auto-variant generation settings per subject
ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS auto_variants_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS max_variants_per_card  INTEGER;
