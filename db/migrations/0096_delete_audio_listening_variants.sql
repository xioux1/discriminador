-- Remove all card variants of type 'listening' and any variant whose prompt_text
-- begins with the word "audio" (case-insensitive). These are no longer permitted.
DELETE FROM card_variants
WHERE variant_type = 'listening'
   OR prompt_text ~* '^\s*audio\b';
