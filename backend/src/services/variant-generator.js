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
- CRÍTICO: Si la pregunta original contiene una ecuación, fórmula matemática, expresión algebraica o cualquier objeto matemático concreto, la variante DEBE incluir también una ecuación o expresión concreta equivalente. NUNCA generes una pregunta más genérica que la original omitiendo la ecuación específica. Por ejemplo, si la original pregunta sobre "dy/dt = mt/y", la variante debe preguntar sobre otra ecuación diferencial concreta, no simplemente "Halle la solución general de la ecuación diferencial" sin especificarla.
- Mantené EXACTAMENTE el idioma original de cada parte: la QUESTION debe estar en el mismo idioma que la pregunta original, y el ANSWER debe estar en el mismo idioma que la respuesta esperada original. Si la tarjeta es bilingüe (por ejemplo, pregunta en español y respuesta en chino mandarín), la variante debe mantener esa misma estructura: pregunta en español y respuesta en chino. NUNCA traduzcas la pregunta al idioma de la respuesta ni viceversa.
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

/**
 * Build a listening variant for a Chinese card.
 * No LLM needed — the variant stores the Hanzi as the prompt so the frontend
 * can play it via TTS and ask the student to write it from hearing alone.
 */
export function buildChineseListeningVariant({ expected_answer_text }) {
  return {
    prompt_text:          expected_answer_text,
    expected_answer_text: expected_answer_text,
    variant_type:         'listening'
  };
}
