-- Clear all existing explanation artifacts so they are regenerated
-- with the corrected prompt that strictly follows the expected answer.
DELETE FROM card_explanation_artifacts;
