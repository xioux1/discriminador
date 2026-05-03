CREATE TABLE transcript_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  timestamp_start INTERVAL,
  timestamp_end INTERVAL,
  chunk_index INTEGER NOT NULL,
  embedding VECTOR(1536),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX ON transcript_chunks USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ON transcript_chunks (document_id);
