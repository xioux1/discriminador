BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'edge_type_enum') THEN
    CREATE TYPE edge_type_enum AS ENUM ('STRUCTURAL', 'SEMANTIC');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_uri TEXT NOT NULL,
  source_checksum TEXT,
  chunk_size_tokens INT,
  chunk_overlap_tokens INT,
  extraction_model TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  clustering_algo TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'chunking', 'extracting', 'embedding', 'clustering', 'done', 'failed')),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  position_in_doc INT NOT NULL,
  page_start INT,
  page_end INT,
  token_count INT,
  text TEXT NOT NULL,
  structural_path TEXT[] NOT NULL DEFAULT '{}',
  depth INT NOT NULL DEFAULT 0 CHECK (depth >= 0),
  embedding_ref TEXT,
  embedding_model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS concepts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  canonical_label TEXT NOT NULL,
  description TEXT,
  confidence NUMERIC(5,4),
  extraction_model TEXT NOT NULL,
  structural_path TEXT[] NOT NULL DEFAULT '{}',
  depth INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunk_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  to_chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  edge_type edge_type_enum NOT NULL,
  weight NUMERIC(8,6),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_id UUID REFERENCES ingestion_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_chunk_id <> to_chunk_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_structural_edge
  ON chunk_edges (from_chunk_id, to_chunk_id, edge_type)
  WHERE edge_type = 'STRUCTURAL';

CREATE UNIQUE INDEX IF NOT EXISTS uq_semantic_edge_undirected
  ON chunk_edges (
    LEAST(from_chunk_id::text, to_chunk_id::text),
    GREATEST(from_chunk_id::text, to_chunk_id::text),
    edge_type
  )
  WHERE edge_type = 'SEMANTIC';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'questions'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'questions'
        AND column_name = 'structural_path'
    ) THEN
      ALTER TABLE questions ADD COLUMN structural_path TEXT[] DEFAULT '{}';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'questions'
        AND column_name = 'depth'
    ) THEN
      ALTER TABLE questions ADD COLUMN depth INT DEFAULT 0;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'questions'
        AND column_name = 'source_chunk_id'
    ) THEN
      ALTER TABLE questions ADD COLUMN source_chunk_id UUID REFERENCES chunks(id) ON DELETE SET NULL;
    END IF;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_runs_source_uri ON ingestion_runs(source_uri);
CREATE INDEX IF NOT EXISTS idx_runs_status ON ingestion_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_checksum ON ingestion_runs(source_checksum)
  WHERE source_checksum IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chunks_run_pos ON chunks(run_id, position_in_doc);
CREATE INDEX IF NOT EXISTS idx_chunks_run_depth ON chunks(run_id, depth);
CREATE INDEX IF NOT EXISTS idx_chunks_path_gin ON chunks USING GIN (structural_path);

CREATE INDEX IF NOT EXISTS idx_concepts_chunk ON concepts(chunk_id);
CREATE INDEX IF NOT EXISTS idx_concepts_label_trgm ON concepts USING GIN (canonical_label gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_concepts_path_gin ON concepts USING GIN (structural_path);

CREATE INDEX IF NOT EXISTS idx_edges_from_type ON chunk_edges(from_chunk_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_to_type ON chunk_edges(to_chunk_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_type_weight ON chunk_edges(edge_type, weight DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_edges_run ON chunk_edges(run_id);

COMMIT;
