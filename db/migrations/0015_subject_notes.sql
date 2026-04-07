-- Migration: 0012_subject_notes
-- Adds notes_text column to subject_configs for personal class notes
-- (distinct from syllabus_text which is the official program)
ALTER TABLE subject_configs ADD COLUMN IF NOT EXISTS notes_text TEXT;
