-- Migration 0029: per-subject switch to enable/disable micro-card generation
-- When FALSE no micro-cards are generated when reviewing full cards, regardless of max_micro_cards_per_card.
ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS micro_cards_enabled BOOLEAN NOT NULL DEFAULT TRUE;
