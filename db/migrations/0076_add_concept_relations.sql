-- Fase 2A-2: relaciones semánticas intra-cluster entre conceptos.
-- Nullable rationale, pero el servicio descarta entradas con rationale vacío o muy corto.
-- UNIQUE en (source, target, type) para que re-ejecuciones sean idempotentes.

CREATE TABLE IF NOT EXISTS concept_relations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  target_concept_id UUID NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  relation_type     TEXT NOT NULL,
  confidence        FLOAT NOT NULL,
  rationale         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT concept_relations_no_self
    CHECK (source_concept_id <> target_concept_id),
  CONSTRAINT concept_relations_unique
    UNIQUE (source_concept_id, target_concept_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_concept_relations_source ON concept_relations(source_concept_id);
CREATE INDEX IF NOT EXISTS idx_concept_relations_target ON concept_relations(target_concept_id);
