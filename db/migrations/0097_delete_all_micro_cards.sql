-- Remove all micro-cards permanently. Micro-card generation is disabled.
TRUNCATE TABLE micro_cards RESTART IDENTITY CASCADE;
