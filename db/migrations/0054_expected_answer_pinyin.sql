-- Split card back content into clean expected_answer + optional pinyin_hint.

ALTER TABLE cards ADD COLUMN IF NOT EXISTS expected_answer TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS pinyin_hint TEXT;
ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS expected_answer TEXT;
ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS pinyin_hint TEXT;

-- Backfill cards.
UPDATE cards
SET
  expected_answer = COALESCE(NULLIF(expected_answer, ''),
    trim(regexp_replace(expected_answer_text,
      E'\\s*[（(]\\s*[A-Za-züÜvVāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ·'' -]+\\s*[)）]\\s*$',
      '', 'g'))),
  pinyin_hint = COALESCE(NULLIF(pinyin_hint, ''),
    NULLIF(trim((regexp_match(expected_answer_text,
      E'[（(]\\s*([A-Za-züÜvVāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ·'' -]+)\\s*[)）]\\s*$'))[1]), ''))
WHERE expected_answer_text IS NOT NULL;

-- Guarantee clean fallback when no pinyin was detected.
UPDATE cards
SET expected_answer = expected_answer_text
WHERE (expected_answer IS NULL OR trim(expected_answer) = '')
  AND expected_answer_text IS NOT NULL;

-- Normalize legacy field so existing consumers also receive clean answer.
UPDATE cards
SET expected_answer_text = expected_answer
WHERE expected_answer IS NOT NULL
  AND trim(expected_answer) <> '';

-- Backfill variants with the same logic.
UPDATE card_variants
SET
  expected_answer = COALESCE(NULLIF(expected_answer, ''),
    trim(regexp_replace(expected_answer_text,
      E'\\s*[（(]\\s*[A-Za-züÜvVāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ·'' -]+\\s*[)）]\\s*$',
      '', 'g'))),
  pinyin_hint = COALESCE(NULLIF(pinyin_hint, ''),
    NULLIF(trim((regexp_match(expected_answer_text,
      E'[（(]\\s*([A-Za-züÜvVāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ·'' -]+)\\s*[)）]\\s*$'))[1]), ''))
WHERE expected_answer_text IS NOT NULL;

UPDATE card_variants
SET expected_answer = expected_answer_text
WHERE (expected_answer IS NULL OR trim(expected_answer) = '')
  AND expected_answer_text IS NOT NULL;

UPDATE card_variants
SET expected_answer_text = expected_answer
WHERE expected_answer IS NOT NULL
  AND trim(expected_answer) <> '';
