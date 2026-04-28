-- Track when cards generated from a cluster were accepted into a subject
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS cards_added_at TIMESTAMPTZ;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS cards_added_count INTEGER;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS cards_added_subject TEXT;
