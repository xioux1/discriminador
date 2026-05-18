BEGIN;

ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS chunk_id UUID NULL;

-- Backfill from legacy source_chunk_index where possible.
-- We scope matches through documents -> ingestion_runs using source_uri=file_path
-- and then match by chunk_index. If multiple runs exist for same file, prefer latest done run.
WITH ranked_runs AS (
  SELECT
    d.id AS document_id,
    ir.id AS run_id,
    ROW_NUMBER() OVER (
      PARTITION BY d.id
      ORDER BY
        CASE WHEN ir.status = 'done' THEN 0 ELSE 1 END,
        ir.finished_at DESC NULLS LAST,
        ir.created_at DESC
    ) AS rn
  FROM documents d
  JOIN ingestion_runs ir
    ON ir.source_uri = d.file_path
), preferred_runs AS (
  SELECT document_id, run_id
  FROM ranked_runs
  WHERE rn = 1
), candidate_map AS (
  SELECT
    c.id AS concept_id,
    ch.id AS chunk_id
  FROM concepts c
  JOIN preferred_runs pr
    ON pr.document_id = c.document_id
  JOIN chunks ch
    ON ch.run_id = pr.run_id
   AND ch.chunk_index = c.source_chunk_index
  WHERE c.chunk_id IS NULL
    AND c.source_chunk_index IS NOT NULL
)
UPDATE concepts c
SET chunk_id = cm.chunk_id
FROM candidate_map cm
WHERE c.id = cm.concept_id
  AND c.chunk_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_concepts_chunk_id ON concepts(chunk_id);

ALTER TABLE concepts
  DROP CONSTRAINT IF EXISTS concepts_chunk_id_fkey;

ALTER TABLE concepts
  ADD CONSTRAINT concepts_chunk_id_fkey
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE;

COMMIT;
