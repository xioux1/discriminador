-- Extra info field for study cards: optional supplementary text shown on demand during study (e.g. code templates, reference material)
ALTER TABLE cards ADD COLUMN IF NOT EXISTS extra_info TEXT;
