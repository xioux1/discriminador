-- Fase 1: clasificación de conceptos por tipo e importancia.
-- Columnas nullable: documentos existentes quedan con NULL,
-- tratados como core_concept (peso 1.0) en lógica de negocio.

ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS concept_type TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS importance   TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_concepts_type       ON concepts(concept_type);
CREATE INDEX IF NOT EXISTS idx_concepts_importance ON concepts(importance);
