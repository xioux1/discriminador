-- Add columns to the existing concepts table that were defined in the 0081
-- schema but skipped because the table already existed in production.

ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS confidence     NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS canonical_label TEXT,
  ADD COLUMN IF NOT EXISTS description    TEXT;
