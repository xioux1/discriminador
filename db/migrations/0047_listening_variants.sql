ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS variant_type TEXT NOT NULL DEFAULT 'regular';
