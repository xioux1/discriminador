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
 * Detect whether a card contains Chinese (CJK) content by inspecting its text fields.
 */
export function isChineseCard({ prompt_text = '', expected_answer_text = '' }) {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/u.test(`${prompt_text} ${expected_answer_text}`);
}

/**
 * Generate a focused micro-card for Chinese language learning.
 *
 * Rule: one card = one thing (word | structure | order | particle | register).
 *
 * Type A — lexical failure (forgot a word):
 *   Front: "¿Cómo se dice 'X'?"  |  Back: Chinese word only
 *
 * Type B — structural failure (wrong pattern, particle, order, register):
 *   Option 1 (cloze): take the original sentence, blank out only the structural element
 *     Front: "我昨天 ___ 看书"  |  Back: "在家"
 *   Option 2 (mirror): simpler sentence in Spanish → same pattern in Chinese
 *     Front: "Estudio en casa"  |  Back: "我在家学习"
 */
export async function generateChineseMicroCard({ prompt_text, expected_answer_text, subject, concept, user_answer = '' }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL_STRONG,
    max_tokens: 300,
    temperature: 0,
    system: `Sos un tutor especialista en chino mandarín que diseña flashcards.

REGLA BASE (no negociable): una tarjeta testea UNA SOLA COSA: palabra | estructura | orden | partícula | registro.

═══ CLASIFICACIÓN ═══

TIPO A — FALLO LÉXICO (el estudiante no recordó una palabra específica):
  FRONT: ¿Cómo se dice '[palabra en español]'?
  BACK: solo la palabra en chino — nada más.

TIPO B — FALLO ESTRUCTURAL (patrón, partícula, orden u otra estructura):
  Elegí la opción más pedagógica:

  Opción CLOZE (preferida cuando hay oración de referencia):
    Tomá la oración original o una equivalente minimal.
    Reemplazá SOLO el elemento estructural con ___.
    FRONT: oración con ___
    BACK: solo el fragmento faltante
    Ejemplo → FRONT: "我昨天 ___ 看书"  BACK: "在家"

  Opción MIRROR (cuando no hay oración clara):
    Creá una oración más simple con el MISMO patrón.
    FRONT: esa oración en español
    BACK: la oración en chino con ese patrón
    Ejemplo → FRONT: "Estudio en casa"  BACK: "我在家学习"

PROHIBIDO:
- Mezclar léxico y estructura en una sola tarjeta.
- Poner más de un elemento en el BACK.
- Revelar la respuesta en el FRONT.
- Referencias a "la tarjeta", "el ejercicio", "el ejemplo anterior".

Respondé ÚNICAMENTE en este formato (4 líneas):
TYPE: A|B
FORMAT: lexical|cloze|mirror
FRONT: <frente>
BACK: <dorso>`,
    messages: [{
      role: 'user',
      content: `Tarjeta de chino:
Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Respuesta del estudiante: "${user_answer || '(sin respuesta)'}"
Concepto / error a remediar: "${concept}"

Clasificá y generá la micro-tarjeta.`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const frontMatch = text.match(/FRONT:\s*(.+)/i);
  const backMatch  = text.match(/BACK:\s*([\s\S]+)/i);

  return {
    question:        frontMatch?.[1]?.trim() ?? `¿Cómo se dice "${concept}" en chino?`,
    expected_answer: backMatch?.[1]?.trim()  || expected_answer_text,
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
El estudiante cometió un error conceptual en un ejercicio. Tu tarea es generar UNA micro-pregunta que remedie ese error conceptual específico.

OBJETIVO: La pregunta debe poder responderse por cualquier estudiante del tema SIN haber visto el ejercicio original.

═══ REGLAS ESTRICTAS ═══
- PROHIBIDO usar nombres de variables, tablas, columnas, funciones, o entidades del ejercicio original.
- PROHIBIDO referenciar "el ejercicio", "el código anterior", "la estructura anterior", "en este caso", "aquí".
- PROHIBIDO pedir completar o reconstruir parte del ejercicio original.
- La pregunta debe ser sobre el CONCEPTO GENERAL, no sobre la instancia particular del ejercicio.
- Forzá GENERACIÓN desde memoria, no reconocimiento.
- La respuesta esperada debe ser conceptual y concisa (1-3 oraciones), sin código específico del ejercicio.

═══ TIPO DE PREGUNTA SEGÚN EL ERROR ═══
- Error de orden lógico (validar después de operar, condición mal ubicada): preguntá sobre el orden correcto en términos generales y por qué importa.
- Error de concepto equivocado (usó X cuando era Y): preguntá sobre la diferencia entre ambos y cuándo usar cada uno.
- Error de condición invertida: preguntá cuál es la condición correcta y qué consecuencia tiene invertirla.
- Error de uso incorrecto de sentencia: preguntá qué hace esa sentencia, cuándo se usa y qué pasa si se usa mal.

Respondé ÚNICAMENTE en este formato (dos líneas):
QUESTION: <micro-pregunta en español, sin referencias al ejercicio original>
ANSWER: <respuesta esperada concisa y conceptual>`,
    messages: [{
      role: 'user',
      content: `Materia: ${subject || 'no especificada'}
Error conceptual detectado: "${error_label}"

[CONTEXTO INTERNO — no usar nombres ni detalles de esto en la pregunta]
Ejercicio original: ${prompt_text}
Respuesta de referencia: ${expected_answer_text}
Respuesta del estudiante: "${user_answer || '(no disponible)'}"
[FIN CONTEXTO INTERNO]

Generá la micro-pregunta que ataque el concepto general del error, sin mencionar nada del ejercicio original.`
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
