BEGIN;

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS structural_path TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS depth INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cards_structural_path_gin
  ON cards USING GIN (structural_path);

CREATE INDEX IF NOT EXISTS idx_cards_source_chunk_id
  ON cards(source_chunk_id);

CREATE INDEX IF NOT EXISTS idx_cards_depth
  ON cards(depth);

COMMIT;
