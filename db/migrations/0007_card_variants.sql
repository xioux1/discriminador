-- Migration: 0007_card_variants
-- Stores conservative variants of cards. SM-2 always targets the parent card_id.
-- The scheduler picks randomly from the pool (original + variants) on each review.

CREATE TABLE IF NOT EXISTS card_variants (
  id                   SERIAL PRIMARY KEY,
  card_id              INT  NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  prompt_text          TEXT NOT NULL,
  expected_answer_text TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS card_variants_card_id_idx ON card_variants(card_id);
