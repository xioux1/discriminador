-- Remove artifacts generated with the old sequence/concept_map types.
-- They will be regenerated on next review using the new tree/flow types.
DELETE FROM card_explanation_artifacts
WHERE diagram_type IN ('sequence', 'concept_map');
