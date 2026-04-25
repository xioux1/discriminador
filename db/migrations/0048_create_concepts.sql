-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Documents table (input for concept extraction)
CREATE TABLE IF NOT EXISTS documents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,

  original_filename TEXT,
  mime_type         TEXT,
  file_path         TEXT,

  text              TEXT,
  content           TEXT,
  transcript        TEXT,

  status            TEXT DEFAULT 'ready',

  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents(user_id);

-- Concepts table with pgvector embeddings
CREATE TABLE IF NOT EXISTS concepts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  document_id        UUID REFERENCES documents(id) ON DELETE CASCADE,

  label              TEXT NOT NULL,
  definition         TEXT NOT NULL,

  source_chunk       TEXT,
  source_chunk_index INTEGER,
  evidence           TEXT,

  cluster_id         UUID DEFAULT NULL,

  embedding          VECTOR(1536),

  extraction_model   TEXT,
  embedding_model    TEXT,

  status             TEXT DEFAULT 'accepted',

  created_at         TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS concepts_document_id_idx ON concepts(document_id);
CREATE INDEX IF NOT EXISTS concepts_cluster_id_idx  ON concepts(cluster_id);

-- IVFFlat requires training data; use DO block to defer gracefully on empty table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'concepts_embedding_idx'
  ) THEN
    BEGIN
      CREATE INDEX concepts_embedding_idx
      ON concepts
      USING ivfflat (embedding vector_cosine_ops);
    EXCEPTION
      WHEN OTHERS THEN
        RAISE NOTICE 'concepts_embedding_idx deferred (table needs data to train ivfflat): %', SQLERRM;
    END;
  END IF;
END $$;
