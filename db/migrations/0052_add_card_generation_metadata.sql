-- Add cluster-generation metadata to cards (parent card group)
ALTER TABLE cards ADD COLUMN IF NOT EXISTS cluster_id UUID REFERENCES clusters(id) ON DELETE SET NULL;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS card_type TEXT DEFAULT 'theoretical_open';
ALTER TABLE cards ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- Add generation metadata to card_variants (per-concept variants)
ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS source_concept_ids JSONB DEFAULT '[]'::jsonb;
ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS source_chunk_indexes JSONB DEFAULT '[]'::jsonb;
ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS grading_rubric JSONB DEFAULT '[]'::jsonb;
ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS difficulty TEXT DEFAULT 'medium';
ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS answer_time_seconds INTEGER DEFAULT 50;
ALTER TABLE card_variants ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
