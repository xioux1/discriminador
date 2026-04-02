import { randomUUID } from 'node:crypto';
import { Router } from 'express';

const decisionRouter = Router();

const ALLOWED_GRADES = new Set(['pass', 'fail']);
const ALLOWED_STATES = new Set(['accepted_as_suggested', 'manually_corrected', 'flagged_uncertain']);

decisionRouter.post('/decision', (req, res) => {
  const finalGrade = typeof req.body?.final_grade === 'string' ? req.body.final_grade : '';
  const validationState = typeof req.body?.validation_state === 'string' ? req.body.validation_state : '';

  if (!ALLOWED_GRADES.has(finalGrade)) {
    return res.status(400).json({
      error: 'Request Error',
      message: "final_grade must be one of: 'pass' or 'fail'."
    });
  }

  if (!ALLOWED_STATES.has(validationState)) {
    return res.status(400).json({
      error: 'Request Error',
      message: "validation_state must be one of: accepted_as_suggested, manually_corrected, flagged_uncertain."
    });
  }

  return res.status(201).json({
    status: 'saved',
    decision: {
      id: randomUUID(),
      final_grade: finalGrade,
      validation_state: validationState,
      finalized_at: new Date().toISOString()
    }
  });
});

export default decisionRouter;
