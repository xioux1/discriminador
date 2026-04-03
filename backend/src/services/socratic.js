import Anthropic from '@anthropic-ai/sdk';
import { fetchFewShotExamples } from './llm-judge.js';

const LLM_MODEL = 'claude-haiku-4-5';

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

function weakestDimension(dimensions) {
  const order = ['core_idea', 'conceptual_accuracy', 'completeness'];
  return order.reduce((weakest, dim) =>
    (dimensions[dim] ?? 1) < (dimensions[weakest] ?? 1) ? dim : weakest
  , order[0]);
}

const DIMENSION_LABELS = {
  core_idea: 'la idea central del concepto',
  conceptual_accuracy: 'la precisión conceptual',
  completeness: 'la completitud de la respuesta',
};

/**
 * Generate 2 targeted Socratic questions.
 * mode='review': apunta a la brecha para determinar comprensión.
 * mode='fail': apunta al error para guiar el aprendizaje.
 */
export async function generateSocraticQuestions({ prompt_text, user_answer_text, expected_answer_text, subject, dimensions, justification, mode = 'review' }) {
  const weak = weakestDimension(dimensions);
  const weakLabel = DIMENSION_LABELS[weak] || 'la comprensión del concepto';

  const systemPrompt = mode === 'fail'
    ? `Sos un tutor académico. El evaluado respondió incorrectamente una pregunta, con errores en ${weakLabel}.
Tu tarea es generar exactamente 2 preguntas que lo guíen a entender qué estuvo mal y por qué.

Reglas:
- Las preguntas deben ayudarlo a reflexionar sobre su error, no simplemente darle la respuesta.
- Podés insinuar la dirección correcta, pero sin revelar la respuesta esperada.
- Cada pregunta debe poder responderse en 1-3 oraciones.
- Respondé ÚNICAMENTE con este formato exacto, sin texto adicional:
PREGUNTA_1: <pregunta>
PREGUNTA_2: <pregunta>`
    : `Sos un evaluador académico. Una respuesta resultó ambigua o le faltó profundidad en ${weakLabel}.
Tu tarea es generar exactamente 2 preguntas cortas para determinar si el evaluado comprende el concepto.

Reglas:
- Las preguntas deben apuntar directamente a la brecha detectada.
- No telegrafíes la respuesta correcta.
- Cada pregunta debe poder responderse en 1-3 oraciones.
- Respondé ÚNICAMENTE con este formato exacto, sin texto adicional:
PREGUNTA_1: <pregunta>
PREGUNTA_2: <pregunta>`;

  const userMessage = `Materia: ${subject || 'general'}
Pregunta original: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Respuesta del evaluado: ${user_answer_text}
Observación inicial: ${justification}`;

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 256,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const q1 = text.match(/PREGUNTA_1:\s*(.+)/i)?.[1]?.trim();
  const q2 = text.match(/PREGUNTA_2:\s*(.+)/i)?.[1]?.trim();

  if (!q1 || !q2) {
    throw new Error(`Could not parse Socratic questions from LLM response: "${text}"`);
  }

  return { questions: [q1, q2] };
}

/**
 * Re-evaluate with the Socratic Q&A context. Returns PASS or FAIL only.
 */
export async function judgeWithSocraticContext(pool, { prompt_text, user_answer_text, expected_answer_text, subject, socratic_qa }) {
  const examples = await fetchFewShotExamples(pool, subject);

  let systemPrompt = `Sos un evaluador académico calibrado. El evaluado respondió una pregunta de forma ambigua y luego respondió preguntas de profundización.
Tu tarea es determinar, considerando la respuesta inicial Y el diálogo de profundización, si el evaluado demuestra comprensión real del concepto.

Respondé ÚNICAMENTE con este formato exacto (dos líneas, sin texto adicional):
GRADE: PASS|FAIL
JUSTIFICATION: <una oración breve en español>

Criterios:
- PASS: el evaluado demuestra comprensión del concepto central a través del diálogo completo.
- FAIL: las respuestas de profundización confirman que falta comprensión real.

NO penalizar: verbosidad, estilo oral, sinónimos válidos, orden diferente.
IMPORTANTE: Respondé solo PASS o FAIL. No uses REVIEW.`;

  if (examples.length > 0) {
    systemPrompt += '\n\nEjemplos de calibración:\n';
    for (const ex of examples) {
      systemPrompt += `\n---\nPregunta: ${ex.prompt_text}\nRespuesta esperada: ${ex.expected_answer_text}\nRespuesta del evaluado: ${ex.user_answer_text}\nCalificación: ${ex.final_grade.toUpperCase()}`;
      if (ex.reason) systemPrompt += `\nMotivo: ${ex.reason}`;
    }
    systemPrompt += '\n---';
  }

  const dialogue = socratic_qa
    .map((item) => `P: ${item.question}\nR: ${item.answer}`)
    .join('\n');

  const userMessage = `Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Respuesta inicial del evaluado: ${user_answer_text}

Profundización socrática:
${dialogue}`;

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 256,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const gradeMatch = text.match(/GRADE:\s*(PASS|FAIL)/i);
  const justMatch = text.match(/JUSTIFICATION:\s*(.+)/i);

  if (!gradeMatch) {
    throw new Error(`Could not parse grade from Socratic re-evaluation: "${text}"`);
  }

  return {
    suggested_grade: gradeMatch[1].toUpperCase(),
    justification: justMatch ? justMatch[1].trim() : 'Re-evaluación socrática.'
  };
}

/**
 * Generate educational feedback for a FAIL case after Socratic dialogue.
 * Does NOT change the grade — purely for learning.
 */
export async function generateSocraticFeedback({ prompt_text, user_answer_text, expected_answer_text, subject, socratic_qa }) {
  const systemPrompt = `Sos un tutor académico. El evaluado respondió incorrectamente y luego participó de un diálogo socrático.
Tu tarea es dar una explicación educativa breve: qué estuvo mal, por qué, y cuál es la comprensión correcta.

Respondé ÚNICAMENTE con este formato exacto (dos líneas, sin texto adicional):
ERROR: <qué faltó o estuvo mal, en una oración>
CONCEPTO: <la explicación correcta del concepto, en 1-2 oraciones>`;

  const dialogue = socratic_qa
    .map((item) => `P: ${item.question}\nR: ${item.answer}`)
    .join('\n');

  const userMessage = `Materia: ${subject || 'general'}
Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Respuesta del evaluado: ${user_answer_text}

Diálogo socrático:
${dialogue}`;

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 256,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const errorMatch = text.match(/ERROR:\s*(.+)/i);
  const conceptMatch = text.match(/CONCEPTO:\s*(.+)/i);

  return {
    error_summary: errorMatch ? errorMatch[1].trim() : 'No se identificó el error específico.',
    correct_concept: conceptMatch ? conceptMatch[1].trim() : 'Revisá la respuesta esperada para reforzar el concepto.'
  };
}
