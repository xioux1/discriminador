-- Prevent duplicate active micro_cards for the same parent card.
-- This index is PARTIAL (only covers status = 'active'), so archived rows
-- are unaffected and the INSERT ... ON CONFLICT DO NOTHING pattern works.
CREATE UNIQUE INDEX IF NOT EXISTS micro_cards_one_active_per_parent
  ON micro_cards (parent_card_id, user_id)
  WHERE status = 'active';
