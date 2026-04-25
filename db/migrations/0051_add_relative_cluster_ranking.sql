-- Add relative ranking columns to clusters
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS relative_importance_score FLOAT DEFAULT NULL;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS relative_priority_tier TEXT DEFAULT NULL;

-- importance_reasons should already exist from 0050; add defensively
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS importance_reasons JSONB DEFAULT '[]'::jsonb;
