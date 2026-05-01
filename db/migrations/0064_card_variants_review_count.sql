-- Migration: 0064_card_variants_review_count
-- Add review tracking counters to card_variants so we can see how often
-- each variant is actually served during study sessions.

ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS review_count INT NOT NULL DEFAULT 0;
ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS pass_count   INT NOT NULL DEFAULT 0;
