-- Tabla de trazabilidad slide-by-slide para documentos visuales.
-- Replica el patrón de transcript_chunks pero orientado a slides de presentación.
--
-- structured_json almacena el análisis completo de Claude por slide:
-- { slide_number, title, visible_text, formulas, visual_description,
--   diagram_relations, teacher_intent, concepts_candidate, warnings }

CREATE TABLE IF NOT EXISTS document_slides (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  slide_number    INTEGER     NOT NULL,
  image_path      TEXT,
  extracted_text  TEXT,
  visual_summary  TEXT,
  structured_json JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT document_slides_unique UNIQUE (document_id, slide_number)
);

CREATE INDEX document_slides_document_id_idx ON document_slides(document_id);
