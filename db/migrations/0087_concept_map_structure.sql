-- Enrich clusters and cluster_dependencies for block-based concept maps
-- with typed edges and a designated center cluster.

ALTER TABLE clusters
  ADD COLUMN IF NOT EXISTS block_name TEXT,
  ADD COLUMN IF NOT EXISTS is_center  BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE cluster_dependencies
  ADD COLUMN IF NOT EXISTS edge_label         TEXT,
  ADD COLUMN IF NOT EXISTS edge_semantic_type TEXT CHECK (
    edge_semantic_type IS NULL OR edge_semantic_type IN (
      'requires', 'produces', 'enables', 'part_of', 'contrasts_with', 'example_of'
    )
  );
