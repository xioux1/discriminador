-- Add subject field to documents so they can be linked to a materia/subject_config
ALTER TABLE documents ADD COLUMN IF NOT EXISTS subject TEXT DEFAULT NULL;

-- Ranking scores on clusters
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS density_score FLOAT DEFAULT NULL;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS density_coverage_score FLOAT DEFAULT NULL;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS density_intensity_score FLOAT DEFAULT NULL;

ALTER TABLE clusters ADD COLUMN IF NOT EXISTS program_score FLOAT DEFAULT NULL;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS exam_score FLOAT DEFAULT NULL;

ALTER TABLE clusters ADD COLUMN IF NOT EXISTS importance_score FLOAT DEFAULT NULL;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS priority_tier TEXT DEFAULT NULL;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS importance_reasons JSONB DEFAULT '[]'::jsonb;

ALTER TABLE clusters ADD COLUMN IF NOT EXISTS importance_computed_at TIMESTAMP DEFAULT NULL;

-- Cache table for document chunk embeddings (avoids re-embedding on repeated ranking runs)
CREATE TABLE IF NOT EXISTS document_chunk_embeddings (
  id             UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    UUID      REFERENCES documents(id) ON DELETE CASCADE,

  chunk_index    INTEGER   NOT NULL,
  chunk_text     TEXT      NOT NULL,

  embedding      VECTOR(1536),
  embedding_model TEXT     NOT NULL,

  created_at     TIMESTAMP DEFAULT NOW(),

  UNIQUE(document_id, chunk_index, embedding_model)
);

CREATE INDEX IF NOT EXISTS document_chunk_embeddings_document_idx
ON document_chunk_embeddings(document_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'document_chunk_embeddings_vector_idx'
  ) THEN
    BEGIN
      CREATE INDEX document_chunk_embeddings_vector_idx
      ON document_chunk_embeddings
      USING ivfflat (embedding vector_cosine_ops);
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'document_chunk_embeddings_vector_idx deferred (table needs data to train ivfflat): %', SQLERRM;
    END;
  END IF;
END $$;
