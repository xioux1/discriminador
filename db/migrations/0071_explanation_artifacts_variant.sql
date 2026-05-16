-- Add variant_id to explanation artifacts so variants get their own diagram.
-- variant_id is NULL for base cards, set for card_variants.

ALTER TABLE card_explanation_artifacts
  ADD COLUMN IF NOT EXISTS variant_id INTEGER REFERENCES card_variants(id) ON DELETE CASCADE;

-- Drop the old unique constraint that only covered base cards.
ALTER TABLE card_explanation_artifacts
  DROP CONSTRAINT IF EXISTS uq_card_explanation_artifacts_card;

-- Two partial unique indexes: one for base cards, one for variants.
CREATE UNIQUE INDEX IF NOT EXISTS uq_expl_artifact_base
  ON card_explanation_artifacts (card_id, user_id)
  WHERE variant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_expl_artifact_variant
  ON card_explanation_artifacts (card_id, user_id, variant_id)
  WHERE variant_id IS NOT NULL;
