import Anthropic from '@anthropic-ai/sdk';

const LLM_MODEL = 'claude-haiku-4-5';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Given a concept the student missed, generate a focused micro-question
 * that targets ONLY that concept (not the full card).
 *
 * The LLM acts as a tutor choosing the minimal testable formulation,
 * not a mechanical "one card per word" generator.
 */
export async function generateMicroCard({ prompt_text, expected_answer_text, subject, concept }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 256,
    temperature: 0,
    system: `Sos un tutor que genera micro-preguntas de estudio orientadas a remediar un concepto puntual que un estudiante no demostró entender.

Reglas:
- La pregunta debe evaluar ÚNICAMENTE el concepto indicado, no la tarjeta completa.
- Debe poder responderse en 1-2 oraciones.
- Sé directo: preguntá por el concepto sin rodeos.
- La respuesta esperada debe ser concisa (1-2 oraciones máximo).

Respondé ÚNICAMENTE en este formato exacto (dos líneas):
QUESTION: <pregunta corta en español>
ANSWER: <respuesta esperada concisa>`,
    messages: [{
      role: 'user',
      content: `Tarjeta original:
Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Materia: ${subject || 'no especificada'}

Concepto que el estudiante no demostró entender: "${concept}"

Generá la micro-pregunta.`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const questionMatch = text.match(/QUESTION:\s*(.+)/i);
  const answerMatch   = text.match(/ANSWER:\s*([\s\S]+)/i);

  return {
    question: questionMatch?.[1]?.trim() ?? `¿Qué es "${concept}"?`,
    expected_answer: answerMatch?.[1]?.trim() ?? ''
  };
}
