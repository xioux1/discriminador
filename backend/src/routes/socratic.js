import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { isLLMJudgeEnabled } from '../config/env.js';
import { generateSocraticQuestions, judgeWithSocraticContext } from '../services/socratic.js';

const socraticRouter = Router();

function llmGuard(res) {
  if (!isLLMJudgeEnabled()) {
    res.status(503).json({ error: 'service_unavailable', message: 'ENABLE_LLM_JUDGE is not active.' });
    return true;
  }
  return false;
}

socraticRouter.post('/socratic/questions', async (req, res) => {
  if (llmGuard(res)) return;

  const { prompt_text, user_answer_text, expected_answer_text, subject, dimensions, justification } = req.body;

  if (!prompt_text || !user_answer_text || !expected_answer_text || !dimensions) {
    return res.status(422).json({ error: 'validation_error', message: 'prompt_text, user_answer_text, expected_answer_text and dimensions are required.' });
  }

  try {
    const result = await generateSocraticQuestions({
      prompt_text,
      user_answer_text,
      expected_answer_text,
      subject: subject || '',
      dimensions,
      justification: justification || ''
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('Failed to generate Socratic questions', { message: error.message });
    return res.status(500).json({ error: 'server_error', message: 'Failed to generate questions.' });
  }
});

socraticRouter.post('/socratic/evaluate', async (req, res) => {
  if (llmGuard(res)) return;

  const { prompt_text, user_answer_text, expected_answer_text, subject, socratic_qa, evaluation_id } = req.body;

  if (!prompt_text || !user_answer_text || !expected_answer_text) {
    return res.status(422).json({ error: 'validation_error', message: 'prompt_text, user_answer_text and expected_answer_text are required.' });
  }

  if (!Array.isArray(socratic_qa) || socratic_qa.length === 0) {
    return res.status(422).json({ error: 'validation_error', message: 'socratic_qa must be a non-empty array of {question, answer} objects.' });
  }

  const invalidQA = socratic_qa.some((item) => !item.question || !item.answer || item.answer.trim().length < 3);
  if (invalidQA) {
    return res.status(422).json({ error: 'validation_error', message: 'Each socratic_qa item must have question and answer (min 3 chars).' });
  }

  try {
    const result = await judgeWithSocraticContext(dbPool, {
      prompt_text,
      user_answer_text,
      expected_answer_text,
      subject: subject || '',
      socratic_qa
    });

    return res.status(200).json({ ...result, evaluation_id: evaluation_id || null });
  } catch (error) {
    console.error('Failed to run Socratic re-evaluation', { message: error.message });
    return res.status(500).json({ error: 'server_error', message: 'Socratic re-evaluation failed.' });
  }
});

export default socraticRouter;
