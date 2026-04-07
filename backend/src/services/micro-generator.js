import Anthropic from '@anthropic-ai/sdk';

const LLM_MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Given a concept the student missed, generate a focused micro-question
 * that forces active recall — not recognition.
 *
 * Uses a decision tree to pick the best format depending on:
 * - whether the expected answer is a list, definition, procedure, or other
 * - what the student actually wrote (partial cues can scaffold recall)
 */
export async function generateMicroCard({ prompt_text, expected_answer_text, subject, concept, user_answer = '' }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 300,
    temperature: 0,
    system: `Sos un tutor que genera micro-preguntas de estudio para remediar un concepto puntual que un estudiante no demostró recordar.

OBJETIVO: Forzar que el estudiante GENERE la respuesta desde memoria (recall activo), NO que la reconozca.

═══ ÁRBOL DE DECISIÓN ═══

Analizá la respuesta esperada + lo que dijo el estudiante, luego elegí el formato:

CASO A — Respuesta esperada es una LISTA (características, propiedades, ventajas, pasos, etc.)
  Y el estudiante mencionó algunos ítems pero omitió el concepto indicado:
  → Dales los ítems que SÍ mencionaron como pistas, pedí el faltante y su importancia.
  → Ejemplo: "Las características de X son [ítem1], [ítem2], [ítem3]. Te olvidaste de una. ¿Cuál era y por qué es importante?"
  → Regla: los ítems-pista deben ser los que EL ESTUDIANTE ya mencionó, no inventados.

CASO B — Respuesta esperada es una LISTA pero el estudiante casi no respondió nada:
  → Pregunta directa de recall puro sin dar pistas de la lista.
  → Ejemplo: "¿Cuáles son las características de X? Asegurate de incluir [concepto] y explicar su función."

CASO C — Respuesta esperada es una DEFINICIÓN, EXPLICACIÓN o CONCEPTO:
  → Pregunta directa que pida la definición/explicación sin revelarla.
  → Si el estudiante dio una definición incorrecta, podés señalar que su respuesta fue incompleta sin decir la correcta.
  → Ejemplo: "¿Qué es [concepto] y cuándo se aplica?"

CASO D — Respuesta esperada describe un PROCEDIMIENTO o ALGORITMO:
  → Si el estudiante mencionó algunos pasos: dáselos como pista, pedí el faltante.
  → Ejemplo: "El proceso de X incluye los pasos que ya mencionaste ([paso1], [paso2]). ¿Qué paso te faltó y en qué momento del proceso ocurre?"

CASO E — GENÉRICO (no encaja en los anteriores):
  → Pregunta autónoma sobre el concepto que fuerce generación, no reconocimiento.

═══ REGLAS UNIVERSALES ═══
- La pregunta debe poder entenderse SIN ver la tarjeta original.
- NUNCA nombrar el concepto faltante en la pregunta de forma que la respuesta sea obvia.
- NUNCA usar "en esta función", "en este ejemplo", "aquí", "el código anterior".
- La respuesta esperada debe ser concisa (1-2 oraciones).
- Si el dominio es código/SQL/algoritmos, formulá la pregunta en términos conceptuales generales.

Respondé ÚNICAMENTE en este formato (dos líneas):
QUESTION: <micro-pregunta en español>
ANSWER: <respuesta esperada concisa>`,
    messages: [{
      role: 'user',
      content: `Tarjeta original:
Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Materia: ${subject || 'no especificada'}

Respuesta que dio el estudiante: "${user_answer || '(sin respuesta registrada)'}"

Concepto que el estudiante no demostró recordar: "${concept}"

Aplicá el árbol de decisión y generá la micro-pregunta.`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const questionMatch = text.match(/QUESTION:\s*(.+)/i);
  const answerMatch   = text.match(/ANSWER:\s*([\s\S]+)/i);

  return {
    question:        questionMatch?.[1]?.trim() ?? `¿Qué es "${concept}" y por qué es importante?`,
    expected_answer: answerMatch?.[1]?.trim() ?? ''
  };
}
