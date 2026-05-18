-- 0085: Learning graph for clusters
-- Adds pedagogical ordering and prerequisite dependencies between clusters

ALTER TABLE clusters
  ADD COLUMN IF NOT EXISTS learning_order  INT,
  ADD COLUMN IF NOT EXISTS learning_level  TEXT
    CHECK (learning_level IN ('foundational', 'intermediate', 'advanced'));

CREATE TABLE IF NOT EXISTS cluster_dependencies (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  from_cluster_id UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  to_cluster_id   UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cluster_dependency UNIQUE (from_cluster_id, to_cluster_id),
  CONSTRAINT no_self_dependency CHECK (from_cluster_id <> to_cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_cluster_deps_document
  ON cluster_dependencies (document_id);

CREATE INDEX IF NOT EXISTS idx_cluster_deps_to
  ON cluster_dependencies (to_cluster_id);

CREATE INDEX IF NOT EXISTS idx_clusters_learning_order
  ON clusters (document_id, learning_order)
  WHERE learning_order IS NOT NULL;
