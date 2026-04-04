-- Migration: 0004_concept_gaps
-- Stores per-evaluation concept gaps extracted by the LLM judge.
-- Each row represents one missing concept identified for a given evaluation_item.

CREATE TABLE IF NOT EXISTS concept_gaps (
  id                  SERIAL PRIMARY KEY,
  evaluation_item_id  INTEGER NOT NULL REFERENCES evaluation_items(id) ON DELETE CASCADE,
  concept             TEXT NOT NULL,           -- e.g. "función de control"
  subject             TEXT,                    -- denormalised for fast scheduler queries
  prompt_text         TEXT,                    -- denormalised for fast scheduler queries
  final_grade         TEXT,                    -- grade at decision time (pass/fail/review)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS concept_gaps_evaluation_item_idx ON concept_gaps(evaluation_item_id);
CREATE INDEX IF NOT EXISTS concept_gaps_subject_idx         ON concept_gaps(subject);
