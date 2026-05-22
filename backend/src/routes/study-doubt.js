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
 * Multi-turn tutor Q&A after the student has seen their result.
 * Stateless — no DB writes.
 *
 * Body:
 *   card_prompt, expected_answer, grade, subject  — card context (always required)
 *   user_answer   — required on first turn; optional on follow-ups when history is provided
 *   question      — the new user message
 *   history       — optional array of {role:'user'|'assistant', content:string}
 *                   representing prior turns (client-managed)
 */
studyDoubtRouter.post('/study/doubt', async (req, res) => {
  const { card_prompt, expected_answer, user_answer, grade, question, subject, history } = req.body || {};

  if (!card_prompt || !expected_answer) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'card_prompt y expected_answer son obligatorios.'
    });
  }
  if (!question || typeof question !== 'string' || question.trim().length < 1) {
    return res.status(422).json({ error: 'validation_error', message: 'question es obligatorio.' });
  }
  if (question.trim().length > 800) {
    return res.status(422).json({ error: 'validation_error', message: 'question no puede superar 800 caracteres.' });
  }

  const priorTurns = Array.isArray(history)
    ? history.filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : [];

  try {
    const gradeLabel = ['pass','good','easy'].includes(grade) ? 'APROBÓ'
      : ['fail','again'].includes(grade) ? 'NO APROBÓ'
      : grade === 'hard' ? 'INCOMPLETO' : 'REVISIÓN';

    const systemPrompt = `Sos un tutor universitario. El estudiante acaba de responder una tarjeta de estudio y está consultando dudas.
Respondé en español de forma directa y concisa (máximo 5 oraciones). Explicá el concepto sin copiar textualmente la respuesta esperada.
Si la duda está fuera del contexto de la tarjeta, redirigí amablemente al tema.

Contexto de la tarjeta:
Consigna: ${String(card_prompt).slice(0, 800)}
Respuesta esperada: ${String(expected_answer).slice(0, 800)}
${user_answer ? `Respuesta del estudiante: ${String(user_answer).slice(0, 600)}` : ''}
Resultado: ${gradeLabel}
${subject ? `Materia: ${subject}` : ''}`;

    // Build messages: prior history + new user turn
    const messages = [
      ...priorTurns.map(m => ({ role: m.role, content: String(m.content).slice(0, 1200) })),
      { role: 'user', content: question.trim() }
    ];

    const response = await getClient().messages.create({
      model: LLM_MODEL,
      max_tokens: 600,
      temperature: 0.3,
      system: systemPrompt,
      messages
    });

    const answer = response.content.find(b => b.type === 'text')?.text?.trim() ?? '';
    return res.json({ answer });
  } catch (err) {
    console.error('POST /study/doubt error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default studyDoubtRouter;
