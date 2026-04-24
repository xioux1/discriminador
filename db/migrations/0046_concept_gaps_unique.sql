ALTER TABLE concept_gaps
  ADD CONSTRAINT concept_gaps_evaluation_item_concept_unique
  UNIQUE (evaluation_item_id, concept);
