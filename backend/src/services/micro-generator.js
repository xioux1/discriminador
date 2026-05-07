import Anthropic from '@anthropic-ai/sdk';
import { LLM_MODELS } from '../config/env.js';

const LLM_MODEL        = LLM_MODELS.micro;
const LLM_MODEL_STRONG = LLM_MODELS.socratic; // Sonnet — for check-error micro-cards

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// Strip leaked reasoning (CASO labels, separators) and return only the question.
function extractQuestion(text) {
  const lines = text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^CASO\s+[A-Z]/i.test(l))   // drop "CASO A — ..."
    .filter((l) => !/^[-=]{2,}$/.test(l));        // drop "---", "==="

  // Prefer the last line that contains a question mark; fall back to last line.
  const question = [...lines].reverse().find((l) => l.includes('?')) ?? lines.at(-1) ?? '';
  return question.replace(/^["']|["']$/g, '').trim();
}

/**
 * Given a concept the student failed to demonstrate understanding of,
 * generate a Socratic micro-question that leads them to the concept
 * through its underlying need — not by naming it directly.
 */
export async function generateMicroCard({ prompt_text, expected_answer_text, subject, concept, user_answer = '' }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 300,
    temperature: 0,
    system: `Sos un tutor socrático que genera micro-preguntas de estudio para un estudiante que no demostró comprender un concepto puntual.

FILOSOFÍA CENTRAL:
No preguntás sobre el concepto directamente. Primero encontrás la pregunta más simple que, si el estudiante puede responderla, hace que el concepto sea OBVIO por sí solo.
El recall activo es el medio, no el fin. El fin es que el concepto tenga raíz, no que sea un ítem recuperado de memoria.

PROCESO MENTAL ANTES DE GENERAR (no lo escribas, solo pensalo):
1. ¿Qué problema resuelve este concepto? ¿Por qué existe?
2. ¿Cuál es la pregunta más simple que ancla su necesidad?
3. ¿Puede el estudiante llegar al concepto desde esa pregunta sin haberlo memorizado?

REGLAS DE GENERACIÓN:
- Una sola pregunta. Nunca lista de preguntas.
- No menciones el concepto faltante en la pregunta.
- No uses la respuesta esperada como base — usá la comprensión que la genera.
- Si el concepto es una condición (ej. "Jacobiano no nulo"), preguntá qué pasaría si NO se cumple.
- Si el concepto es un paso o proceso, preguntá para qué existe ese paso.
- Si el concepto es una definición, preguntá qué problema deja sin resolver si no existe.

CASOS:

CASO A — El estudiante omitió un concepto de una lista (condiciones, características, propiedades):
  → No des los otros ítems como pista. Preguntá desde el "qué pasa si falta".
  → Ejemplo: En vez de "olvidaste una condición del teorema, ¿cuál era?", preguntá:
    "Imaginá que la transformación mapea dos puntos distintos de S al mismo punto de R. ¿Qué problema tendría la integral resultante?"
  → El estudiante debe llegar a la inyectividad sin que vos la nombres.

CASO B — El estudiante no respondió nada o respondió fuera de tema:
  → Bajá al nivel más fundamental: ¿para qué existe la herramienta/concepto completo?
  → Ejemplo: "¿Qué ventaja te da transformar una integral doble antes de resolverla?"
  → No asumas ningún conocimiento previo del tema específico.

CASO C — El estudiante respondió parcialmente con error conceptual:
  → Tomá lo que dijo y preguntá si se sostiene bajo un caso concreto simple.
  → Ejemplo: si dijo algo impreciso sobre continuidad, preguntá: "¿Puede una función tener derivadas parciales en un punto sin ser continua ahí?"

FORMATO DE SALIDA:
Tu respuesta es ÚNICAMENTE la pregunta. Una sola oración interrogativa.
PROHIBIDO escribir: el caso identificado, separadores (---, ===), razonamiento previo, prefijos como "Micro-pregunta:" o "Pregunta:".
Si escribís algo además de la pregunta, la respuesta es incorrecta.`,
    messages: [{
      role: 'user',
      content: `Tarjeta original:
Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Materia: ${subject || 'no especificada'}

Respuesta que dio el estudiante: "${user_answer || '(sin respuesta registrada)'}"

Concepto que el estudiante no demostró comprender: "${concept}"

Identificá el caso correspondiente y generá la micro-pregunta socrática.`
    }]
  });

  const raw = response.content.find((b) => b.type === 'text')?.text ?? '';

  // Strip any reasoning lines the LLM leaked (CASO headers, separators, blank preamble).
  // Keep only the last non-empty paragraph that contains a question mark.
  const question = extractQuestion(raw) || `¿Qué es "${concept}" y por qué es importante?`;

  return { question, expected_answer: expected_answer_text };
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
  const formatMatch = text.match(/FORMAT:\s*(lexical|mirror)/i);
  const frontMatch  = text.match(/FRONT:\s*(.+)/i);
  const backMatch   = text.match(/BACK:\s*([\s\S]+)/i);

  return {
    question:        frontMatch?.[1]?.trim() ?? `¿Cómo se dice "${concept}" en chino?`,
    expected_answer: backMatch?.[1]?.trim()  || expected_answer_text,
    isLexical:       formatMatch?.[1]?.toLowerCase() === 'lexical',
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

  const raw   = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
  // Validate the LLM actually returned Hanzi; fall back to the full sentence otherwise.
  const hanzi = CJK_RE.test(raw) ? raw : expected_answer_text;
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
