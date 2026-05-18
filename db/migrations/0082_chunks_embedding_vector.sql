BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS embedding VECTOR(1536),
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;

CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_chunks_no_embedding
  ON chunks (run_id)
  WHERE embedding IS NULL;

ALTER TABLE ingestion_runs
  DROP CONSTRAINT IF EXISTS ingestion_runs_status_check;

ALTER TABLE ingestion_runs
  ADD CONSTRAINT ingestion_runs_status_check
  CHECK (status IN ('pending','chunking','extracting','embedding','clustering','done','failed'));

COMMIT;
