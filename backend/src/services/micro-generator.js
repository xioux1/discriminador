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
 *   Front: Spanish word/phrase  |  Back: hanzi only (user types it)
 *
 * Type B — structural failure (wrong pattern, particle, order, register):
 *   Front: simple Spanish sentence using the failed structure
 *   Back: that sentence in hanzi (user types it)
 */
export async function generateChineseMicroCard({ prompt_text, expected_answer_text, subject, concept, user_answer = '' }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL_STRONG,
    max_tokens: 300,
    temperature: 0,
    system: `Sos un tutor especialista en chino mandarín que diseña flashcards.

REGLA BASE (no negociable): una tarjeta testea UNA SOLA COSA: palabra | estructura | orden | partícula | registro.
En TODAS las tarjetas el estudiante tipea hanzi como respuesta. El FRONT siempre está en español.

═══ CLASIFICACIÓN ═══

TIPO A — FALLO LÉXICO (el estudiante no recordó una palabra específica):
  FRONT: la palabra o frase en español — sin adornos, sin signos de pregunta.
  BACK: solo el hanzi correspondiente — nada más.
  Ejemplo → FRONT: "biblioteca"  BACK: "图书馆"

TIPO B — FALLO ESTRUCTURAL (patrón, partícula, orden u otra estructura):
  Creá una oración corta y simple (4-6 palabras en español) que use EXACTAMENTE el patrón fallado.
  FRONT: esa oración en español
  BACK: la misma oración en hanzi
  Ejemplo → FRONT: "Estudio en casa"  BACK: "我在家学习"

PROHIBIDO:
- Usar caracteres chinos en el FRONT bajo ninguna circunstancia.
- Usar formato cloze (frases con ___).
- Mezclar léxico y estructura en una sola tarjeta.
- Poner más de una oración en el BACK.
- Revelar la respuesta en el FRONT.
- Referencias a "la tarjeta", "el ejercicio", "el ejemplo anterior".

Respondé ÚNICAMENTE en este formato (4 líneas):
TYPE: A|B
FORMAT: lexical|mirror
FRONT: <frente en español>
BACK: <hanzi>`,
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

const CJK_RE = /[一-鿿㐀-䶿]/u;

/**
 * Generate a listening micro-card for a Chinese listening-variant failure.
 * The student hears the Hanzi via TTS and must type it — the same mechanic as
 * the listening variant itself, but scoped to the specific concept they missed.
 *
 * If the concept is already Hanzi, use it directly.
 * Otherwise, ask the LLM to extract/derive the matching Hanzi from the full sentence.
 *
 * @param {{ expected_answer_text: string, concept: string }} params
 * @returns {{ question: string, expected_answer: string }}
 */
export async function generateChineseListeningMicroCard({ expected_answer_text, concept }) {
  if (CJK_RE.test(concept)) {
    const hanzi = concept.trim();
    return { question: hanzi, expected_answer: hanzi };
  }

  const response = await getClient().messages.create({
    model:       LLM_MODEL_STRONG,
    max_tokens:  60,
    temperature: 0,
    system: `Sos un tutor de chino mandarín. Dado el concepto que el estudiante falló y la oración china completa, devolvé ÚNICAMENTE los caracteres hanzi que corresponden a ese concepto — sin pinyin, sin explicaciones, sin puntuación extra.`,
    messages: [{
      role:    'user',
      content: `Oración completa: ${expected_answer_text}\nConcepto fallado: ${concept}`,
    }],
  });

  const hanzi = response.content.find((b) => b.type === 'text')?.text?.trim() || expected_answer_text;
  return { question: hanzi, expected_answer: hanzi };
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

/**
 * Rank gaps from most to least difficult to acquire, so the most valuable
 * concept gets turned into a microcard first.
 *
 * Falls back to the original order if the LLM call fails or returns
 * an unparseable response.
 */
export async function rankGaps({ prompt_text, expected_answer_text, user_answer = '', gaps }) {
  if (!gaps || gaps.length <= 1) return gaps ?? [];

  const numberedList = gaps.map((g, i) => `${i + 1}. ${g}`).join('\n');

  const prompt = `A student failed a flashcard. The evaluator identified the following gaps in their answer. Your job is to rank these gaps from MOST to LEAST difficult to acquire, so the most valuable concept gets turned into a microcard first.

## Card context
- Front (prompt): ${prompt_text}
- Expected answer: ${expected_answer_text}
- Student's answer: ${user_answer}

## Gaps identified
${numberedList}

## Ranking criteria (apply in order)

1. LEXICAL gaps first — unknown or confused vocabulary items.
2. Within lexical: prioritize words the student clearly attempted but got wrong over words they skipped entirely (skipped = likely just didn't know, less nuanced to fix).
3. If two gaps are equivalent in difficulty, prefer the one more central to the card's core meaning.

## Output format
Return ONLY a JSON array of the gap strings in ranked order, most difficult first. No explanation, no preamble, no markdown fences.

Example output:
["gap 3 text", "gap 1 text", "gap 2 text"]`;

  try {
    const response = await getClient().messages.create({
      model:      LLM_MODEL,
      max_tokens: 256,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
    const ranked = JSON.parse(text);

    if (!Array.isArray(ranked)) return gaps;

    // Validate every item is a known gap string; discard hallucinations.
    const gapSet = new Set(gaps);
    const filtered = ranked.filter((g) => typeof g === 'string' && gapSet.has(g));

    // Append any gaps the LLM dropped (safety net).
    const missing = gaps.filter((g) => !filtered.includes(g));
    return [...filtered, ...missing];
  } catch {
    return gaps;
  }
}
