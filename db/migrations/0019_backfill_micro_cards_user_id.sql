-- Migration: 0019_backfill_micro_cards_user_id
-- Corrective backfill for historical micro_cards created without user_id.
-- Optional diagnostic before/after running:
--   SELECT COUNT(*) AS null_user_micro_cards FROM micro_cards WHERE user_id IS NULL;

UPDATE micro_cards mc
SET user_id = c.user_id,
    updated_at = now()
FROM cards c
WHERE mc.parent_card_id = c.id
  AND mc.user_id IS NULL
  AND c.user_id IS NOT NULL;

-- Optional post-check for rows that still cannot be backfilled because parent card lacks user_id:
--   SELECT mc.id, mc.parent_card_id
--   FROM micro_cards mc
--   LEFT JOIN cards c ON c.id = mc.parent_card_id
--   WHERE mc.user_id IS NULL
--   ORDER BY mc.id;
