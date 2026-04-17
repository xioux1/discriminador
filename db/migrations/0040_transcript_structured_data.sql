ALTER TABLE subject_class_notes
  ADD COLUMN IF NOT EXISTS structured_data JSONB,
  ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT NULL;
