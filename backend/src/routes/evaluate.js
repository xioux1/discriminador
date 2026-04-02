import { Router } from 'express';

const evaluateRouter = Router();

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function scoreField(value) {
  return value ? 1 : 0;
}

evaluateRouter.post('/evaluate', (req, res) => {
  const promptText = normalize(req.body?.prompt_text);
  const userAnswerText = normalize(req.body?.user_answer_text);
  const expectedAnswerText = normalize(req.body?.expected_answer_text);

  if (!promptText || !userAnswerText || !expectedAnswerText) {
    return res.status(400).json({
      error: 'Request Error',
      message: 'prompt_text, user_answer_text and expected_answer_text are required.'
    });
  }

  const dimensions = {
    core_idea: scoreField(userAnswerText),
    conceptual_accuracy: scoreField(expectedAnswerText),
    completeness: userAnswerText.length >= 20 ? 1 : 0.5,
    memorization_risk: 0.5
  };

  const overallScore = Number(
    ((dimensions.core_idea + dimensions.conceptual_accuracy + dimensions.completeness + dimensions.memorization_risk) / 4).toFixed(2)
  );

  const suggestedGrade = overallScore >= 0.6 ? 'pass' : 'fail';

  return res.status(200).json({
    suggested_grade: suggestedGrade,
    overall_score: overallScore,
    dimensions,
    justification_short:
      suggestedGrade === 'pass'
        ? 'La respuesta parece capturar el núcleo esperado, pero requiere revisión humana final.'
        : 'La respuesta no alcanza el umbral mínimo y requiere corrección manual.',
    model_confidence: 0.5
  });
});

export default evaluateRouter;
