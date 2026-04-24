CREATE TABLE IF NOT EXISTS clusters (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT      NOT NULL,
  definition  TEXT,
  document_id UUID      REFERENCES documents(id) ON DELETE CASCADE,
  stamp       TIMESTAMP DEFAULT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS clusters_document_id_idx
ON clusters(document_id);
