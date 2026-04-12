-- Migration: 0026_micro_cards_subject
-- Add subject column to micro_cards so they can be filtered by subject
-- without always joining to the parent card.

ALTER TABLE micro_cards
  ADD COLUMN IF NOT EXISTS subject TEXT;

-- Backfill from parent card for any existing rows where subject is null.
UPDATE micro_cards mc
SET    subject = c.subject
FROM   cards c
WHERE  c.id = mc.parent_card_id
  AND  mc.subject IS NULL
  AND  c.subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS micro_cards_subject_idx ON micro_cards (subject);
