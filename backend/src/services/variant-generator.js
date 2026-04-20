import Anthropic from '@anthropic-ai/sdk';

const LLM_MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Generate a conservative variant of a card.
 * The variant keeps the same concept, difficulty, and structure.
 * Only surface details change (numbers, names, examples).
 * For SQL cards the variant always includes the table schemas used,
 * prepended to the question, so the student knows the structure even
 * when the original card didn't show it.
 */
export async function generateVariant({ prompt_text, expected_answer_text, subject }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 800,
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
- Escribí EXACTAMENTE en el mismo idioma que la respuesta esperada original. Si la respuesta original está en chino mandarín, la variante debe estar en chino mandarín. Si está en japonés, en japonés. Nunca cambies el idioma de escritura, aunque el contenido de la pregunta mencione palabras, lugares o personas de otro idioma.
- Si la pregunta o respuesta contiene SQL, SIEMPRE incluí un bloque TABLES que liste los esquemas de TODAS las tablas que aparecen en la variante, en el formato: NOMBRE_TABLA(COL1, COL2, COL3(FK)). Si la pregunta original no tenía tablas, inventialas con nombres coherentes y listalas igual.

Respondé ÚNICAMENTE en este formato exacto:
TABLES: <esquemas de tablas separados por " | ", o "none" si no hay SQL>
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
  const tablesMatch   = text.match(/TABLES:\s*([\s\S]+?)(?=\nQUESTION:)/i);
  const questionMatch = text.match(/QUESTION:\s*([\s\S]+?)(?=\nANSWER:)/i);
  const answerMatch   = text.match(/ANSWER:\s*([\s\S]+)/i);

  if (!questionMatch || !answerMatch) {
    throw new Error('El LLM no devolvió el formato esperado');
  }

  const tables = tablesMatch ? tablesMatch[1].trim() : null;
  const question = questionMatch[1].trim();

  const finalPrompt = (tables && tables.toLowerCase() !== 'none')
    ? `${tables}\n\n${question}`
    : question;

  return {
    prompt_text:          finalPrompt,
    expected_answer_text: answerMatch[1].trim()
  };
}
