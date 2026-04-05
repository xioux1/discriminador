import Anthropic from '@anthropic-ai/sdk';

const LLM_MODEL = 'claude-haiku-4-5';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Generate a conservative variant of a card.
 * The variant keeps the same concept, difficulty, and structure.
 * Only surface details change (numbers, names, examples).
 */
export async function generateVariant({ prompt_text, expected_answer_text, subject }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 400,
    temperature: 0.3,
    system: `Sos un tutor que genera variantes conservadoras de tarjetas de estudio.

Reglas estrictas:
- El concepto evaluado debe ser IDÉNTICO al original.
- La dificultad debe ser IDÉNTICA.
- La estructura de la pregunta debe ser MUY SIMILAR.
- Solo podés cambiar detalles superficiales: números, nombres de variables, nombres de tablas/columnas, ejemplos concretos, orden de elementos.
- NO cambiés el tipo de razonamiento requerido.
- NO agregués ni quitées conceptos.
- La respuesta esperada debe seguir la misma estructura que la original.
- Escribí en el mismo idioma que la tarjeta original.

Respondé ÚNICAMENTE en este formato exacto:
QUESTION: <variante de la pregunta>
ANSWER: <variante de la respuesta esperada>`,
    messages: [{
      role: 'user',
      content: `Tarjeta original:
Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Materia: ${subject || 'no especificada'}

Generá una variante conservadora.`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const questionMatch = text.match(/QUESTION:\s*(.+)/i);
  const answerMatch   = text.match(/ANSWER:\s*([\s\S]+)/i);

  if (!questionMatch || !answerMatch) {
    throw new Error('El LLM no devolvió el formato esperado');
  }

  return {
    prompt_text:          questionMatch[1].trim(),
    expected_answer_text: answerMatch[1].trim()
  };
}
