-- Store the grading rubric on the parent card row so evaluations can use
-- it to determine which elements are essential for a passing grade.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS grading_rubric JSONB DEFAULT '[]'::jsonb;
