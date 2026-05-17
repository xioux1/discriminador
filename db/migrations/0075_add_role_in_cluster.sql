-- Fase 2A-1: rol de cada concepto dentro de su cluster.
-- Nullable: conceptos existentes mantienen NULL hasta que se re-clusterice.
-- NULL se interpreta como "sin clasificar" en la UI y en el generador de cards.

ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS role_in_cluster TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_concepts_role_in_cluster ON concepts(role_in_cluster);
