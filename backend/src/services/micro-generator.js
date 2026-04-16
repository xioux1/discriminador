import Anthropic from '@anthropic-ai/sdk';
import { LLM_MODELS } from '../config/env.js';

const LLM_MODEL        = LLM_MODELS.micro;
const LLM_MODEL_STRONG = LLM_MODELS.socratic; // Sonnet — for check-error micro-cards

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
    expected_answer: answerMatch?.[1]?.trim() || expected_answer_text
  };
}

/**
 * Generate a targeted micro-card from a conceptual error detected by the binary verifier.
 * Uses a stronger model (Sonnet) since the error label already tells us exactly what went wrong.
 *
 * @param {{ prompt_text, expected_answer_text, subject, error_label, user_answer }} params
 * @returns {{ question, expected_answer }}
 */
export async function generateMicroCardFromCheckError({ prompt_text, expected_answer_text, subject, error_label, user_answer = '' }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL_STRONG,
    max_tokens: 400,
    temperature: 0,
    system: `Sos un tutor experto en diseño de micro-preguntas de estudio.
El estudiante estaba resolviendo un ejercicio y el verificador detectó un error CONCEPTUAL específico mientras escribía.
Tu tarea es generar UNA micro-pregunta que ataque directamente ese error conceptual y lleve al estudiante a construir el conocimiento correcto.

PRINCIPIOS:
- La pregunta debe ser autónoma: entendible sin ver el ejercicio original.
- Forzá GENERACIÓN desde memoria, no reconocimiento.
- Apuntá al concepto mal aplicado, no a los detalles de sintaxis.
- Si el error es de orden lógico (ej: validar después de operar en lugar de antes), preguntá sobre el orden correcto y por qué.
- Si el error es de concepto equivocado (ej: usó función X cuando correspondía Y), preguntá sobre la diferencia y cuándo usar cada una.
- Si el error es de condición invertida (ej: actualizó cuando no debería), preguntá cuál es la condición correcta.
- La respuesta esperada debe ser concisa y conceptual (1-3 oraciones), no código completo.

Respondé ÚNICAMENTE en este formato (dos líneas):
QUESTION: <micro-pregunta en español>
ANSWER: <respuesta esperada concisa>`,
    messages: [{
      role: 'user',
      content: `Materia: ${subject || 'no especificada'}
Ejercicio original: ${prompt_text}
Respuesta esperada de referencia: ${expected_answer_text}
Respuesta del estudiante al momento del error: "${user_answer || '(no disponible)'}"
Error conceptual detectado por el verificador: "${error_label}"

Generá la micro-pregunta que remedie este error conceptual específico.`
    }]
  });

  const text         = response.content.find((b) => b.type === 'text')?.text ?? '';
  const questionMatch = text.match(/QUESTION:\s*(.+)/i);
  const answerMatch   = text.match(/ANSWER:\s*([\s\S]+)/i);

  return {
    question:        questionMatch?.[1]?.trim() ?? `¿Cómo se aplica correctamente: "${error_label}"?`,
    expected_answer: answerMatch?.[1]?.trim() || expected_answer_text,
  };
}
