CREATE TABLE IF NOT EXISTS document_sections (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  title             TEXT        NOT NULL,
  section_type      TEXT        NOT NULL DEFAULT 'stage',  -- 'stage' | 'intro' | 'transversal'
  parent_section_id UUID        REFERENCES document_sections(id) ON DELETE SET NULL,
  order_index       INTEGER     NOT NULL,
  source_slide_start INTEGER,
  source_slide_end   INTEGER,
  summary           TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_sections_document_id
  ON document_sections(document_id);

CREATE INDEX IF NOT EXISTS idx_document_sections_order
  ON document_sections(document_id, order_index);
