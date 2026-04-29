-- Stores a plain-language explanation of the expected answer, generated once
-- by a lightweight model (Haiku) and cached for all future reviews.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS easy_explanation TEXT;
