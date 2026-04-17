-- The old unique index only allowed one active micro-card per parent card per user.
-- This prevented generating multiple micro-cards from multiple error labels.
-- Replace it with a per-concept unique index so each concept gets its own micro-card.
DROP INDEX IF EXISTS micro_cards_one_active_per_parent;

CREATE UNIQUE INDEX IF NOT EXISTS micro_cards_unique_concept_per_parent
  ON micro_cards (parent_card_id, user_id, concept)
  WHERE status = 'active';
