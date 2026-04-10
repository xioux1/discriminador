-- Step 1: archive duplicate active micro_cards, keeping only the newest per parent.
-- This must run before the unique index creation or it will fail on existing dupes.
UPDATE micro_cards
SET status = 'archived', updated_at = now()
WHERE status = 'active'
  AND id NOT IN (
    SELECT DISTINCT ON (parent_card_id, user_id) id
    FROM micro_cards
    WHERE status = 'active'
    ORDER BY parent_card_id, user_id, created_at DESC
  );

-- Step 2: create the partial unique index now that duplicates are gone.
CREATE UNIQUE INDEX IF NOT EXISTS micro_cards_one_active_per_parent
  ON micro_cards (parent_card_id, user_id)
  WHERE status = 'active';
