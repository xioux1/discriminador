import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';

const studyDoubtRouter = Router();
const LLM_MODEL = 'claude-haiku-4-5';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * POST /study/doubt
 * Single-turn tutor Q&A after the student has seen their result.
 * Stateless — no DB writes.
 */
studyDoubtRouter.post('/study/doubt', async (req, res) => {
  const { card_prompt, expected_answer, user_answer, grade, question, subject } = req.body || {};

  if (!card_prompt || !expected_answer || !user_answer || !question) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'card_prompt, expected_answer, user_answer y question son obligatorios.'
    });
  }
  if (typeof question !== 'string' || question.trim().length < 3) {
    return res.status(422).json({ error: 'validation_error', message: 'question debe tener al menos 3 caracteres.' });
  }
  if (question.trim().length > 600) {
    return res.status(422).json({ error: 'validation_error', message: 'question no puede superar 600 caracteres.' });
  }

  try {
    const gradeLabel = grade === 'pass' ? 'APROBÓ' : grade === 'fail' ? 'NO APROBÓ' : 'REVISIÓN';
    const userMessage = `Contexto de la tarjeta:
Consigna: ${String(card_prompt).slice(0, 800)}
Respuesta esperada: ${String(expected_answer).slice(0, 800)}
Respuesta del estudiante: ${String(user_answer).slice(0, 600)}
Resultado: ${gradeLabel}
${subject ? `Materia: ${subject}` : ''}

Duda del estudiante: ${question.trim()}`;

    const response = await getClient().messages.create({
      model: LLM_MODEL,
      max_tokens: 600,
      temperature: 0.3,
      system: `Sos un tutor universitario. El estudiante acaba de responder una tarjeta de estudio y tiene una duda puntual.
Respondé en español de forma directa y concisa (máximo 4 oraciones). Explicá el concepto sin copiar textualmente la respuesta esperada.
Si la duda está fuera del contexto de la tarjeta, redirigí amablemente al tema.`,
      messages: [{ role: 'user', content: userMessage }]
    });

    const answer = response.content.find(b => b.type === 'text')?.text?.trim() ?? '';
    return res.json({ answer });
  } catch (err) {
    console.error('POST /study/doubt error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default studyDoubtRouter;
