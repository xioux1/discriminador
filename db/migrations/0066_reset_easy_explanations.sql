-- Reset cached easy explanations so they are regenerated with the improved prompt and model.
UPDATE cards SET easy_explanation = NULL WHERE easy_explanation IS NOT NULL;
