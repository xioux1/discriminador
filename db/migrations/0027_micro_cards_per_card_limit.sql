-- Migration: 0027_micro_cards_per_card_limit
-- Add max_micro_cards_per_card to subject_configs so users can cap how
-- many active micro-cards accumulate per parent card in each subject.

ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS max_micro_cards_per_card INTEGER;
