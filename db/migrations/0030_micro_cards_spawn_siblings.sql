-- Migration 0030: per-subject toggle to allow micro-cards to spawn sibling micro-cards
-- When TRUE, failing a micro-card can generate new sibling micro-cards for the missed concepts,
-- using the same parent card as context. Respects max_micro_cards_per_card cap.
ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS micro_cards_spawn_siblings BOOLEAN NOT NULL DEFAULT FALSE;
