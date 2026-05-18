-- Key concepts selected by the LLM for display in the concept map.
-- Stored as a JSONB array of short label strings.
ALTER TABLE clusters
  ADD COLUMN IF NOT EXISTS key_map_concepts JSONB NOT NULL DEFAULT '[]'::jsonb;
