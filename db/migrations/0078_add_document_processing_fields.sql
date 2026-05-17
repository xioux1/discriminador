-- Campos de tracking para procesamiento visual de documentos (PPTX, PDF visual)
--
-- processing_mode values : 'plain_text' | 'pdf_text' | 'pdf_visual' | 'pptx_visual'
-- visual_processing_status: NULL | 'pending' | 'converting' | 'analyzing'
--                           | 'reconstructing' | 'done' | 'failed'
--
-- Todos los documentos existentes quedan en processing_mode = 'plain_text',
-- preservando el comportamiento actual sin cambios.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS processing_mode         TEXT        NOT NULL DEFAULT 'plain_text',
  ADD COLUMN IF NOT EXISTS visual_processing_status TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS generated_markdown       TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS file_size_bytes          BIGINT      DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS page_count               INTEGER     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS processing_error         TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS processing_started_at    TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS processing_completed_at  TIMESTAMPTZ DEFAULT NULL;
