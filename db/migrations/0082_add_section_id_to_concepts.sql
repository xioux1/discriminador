ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES document_sections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_concepts_section_id ON concepts(section_id);
