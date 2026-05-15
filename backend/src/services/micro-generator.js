import Anthropic from '@anthropic-ai/sdk';
import { LLM_MODELS } from '../config/env.js';

const LLM_MODEL        = LLM_MODELS.micro;
const LLM_MODEL_STRONG = LLM_MODELS.socratic; // Sonnet — for check-error micro-cards

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// ─── Code-subject detection ────────────────────────────────────────────────

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const CODE_SUBJECT_KEYWORDS = [
  'sql', 'base', 'datos', 'bd', 'oracle', 'pl/sql', 'plsql', 'query',
  'consult', 'stored', 'cursor', 'trigger', 'procedure',
  'python', 'java', 'codigo', 'code', 'programac', 'algoritm',
];

export function isCodeSubject(subject) {
  if (!subject || typeof subject !== 'string') return false;
  const s = stripDiacritics(subject.trim().toLowerCase());
  return CODE_SUBJECT_KEYWORDS.some((k) => s.includes(k));
}

// ─── Strip leaked reasoning ─────────────────────────────────────────────────

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

const ANGLE_PROMPTS = [
  null, // slot 0 — base prompt, no override
  `ÁNGULO — PARA QUÉ EXISTE:
Preguntá para qué sirve este concepto. ¿Qué no podría hacerse sin él?`,
  `ÁNGULO — APLICACIÓN:
Planteá una situación concreta y corta. Pedile al estudiante qué haría en ese caso.`,
  `ÁNGULO — DIFERENCIA:
Preguntá en qué se diferencia este concepto de la opción más parecida.`,
];

/**
 * Analyse the student's answer and choose the best pedagogical strategy
 * before generating the micro-card.  Keeps the generator focused on
 * execution rather than diagnosis.
 *
 * Returns { diagnosis, strategy, reason } where strategy is one of:
 *   FUNDAMENTO | CONSECUENCIA | ANALOGÍA | DISTINCIÓN | APLICACIÓN | CORRECCIÓN
 */
async function planMicroCard({ prompt_text, expected_answer_text, concept, user_answer }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 200,
    temperature: 0,
    system: `Sos un experto en pedagogía. Analizás la respuesta de un estudiante para elegir la mejor estrategia de enseñanza.

ESTRATEGIAS:
- FUNDAMENTO: No respondió o su respuesta no tiene relación → preguntá qué es/para qué sirve el concepto
- CONSECUENCIA: Mencionó algo relacionado pero le faltó el concepto → preguntá qué pasaría sin él
- ANALOGÍA: Está confundido con algo abstracto → conectá con algo cotidiano conocido
- DISTINCIÓN: Confundió el concepto con otro similar → preguntá la diferencia puntual
- APLICACIÓN: Entiende en abstracto pero no en práctica → planteá un caso concreto mínimo
- CORRECCIÓN: Dijo algo específicamente incorrecto → preguntá si su lógica resiste el caso más simple

Respondé SOLO en este formato (3 líneas, sin nada más):
DIAGNÓSTICO: <qué sabe y qué no sabe el estudiante, 1 oración>
ESTRATEGIA: <FUNDAMENTO|CONSECUENCIA|ANALOGÍA|DISTINCIÓN|APLICACIÓN|CORRECCIÓN>
RAZÓN: <por qué esta estrategia es la mejor aquí, 1 oración>`,
    messages: [{
      role: 'user',
      content: `Tarjeta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Respuesta del estudiante: "${user_answer || '(sin respuesta)'}"
Concepto no entendido: "${concept}"`,
    }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const diagnosisMatch = text.match(/DIAGNÓSTICO:\s*(.+)/i);
  const strategyMatch  = text.match(/ESTRATEGIA:\s*(\S+)/i);
  const reasonMatch    = text.match(/RAZÓN:\s*(.+)/i);

  return {
    diagnosis: diagnosisMatch?.[1]?.trim() ?? '',
    strategy:  strategyMatch?.[1]?.trim().toUpperCase() ?? 'FUNDAMENTO',
    reason:    reasonMatch?.[1]?.trim() ?? '',
  };
}

const STRATEGY_GUIDE = `CÓMO EJECUTAR CADA ESTRATEGIA:
- FUNDAMENTO: Preguntá para qué existe el concepto o qué es. Lo más simple posible.
- CONSECUENCIA: Preguntá qué pasaría si ese concepto no estuviera.
- ANALOGÍA: Planteá una analogía con algo cotidiano y preguntá si la entiende.
- DISTINCIÓN: Preguntá en qué se diferencia del concepto con el que lo confundió.
- APLICACIÓN: Planteá una situación concreta mínima. Pedile qué haría.
- CORRECCIÓN: Tomá lo que dijo y preguntá si funciona en el caso más simple posible.`;

/**
 * Given a concept the student failed to demonstrate understanding of,
 * generate a simple Socratic micro-question.
 *
 * Slot 0 (primary card): runs a planner first to choose the best pedagogical
 * strategy based on the student's specific answer, then generates accordingly.
 * Slots 1–3 (sibling diversity cards): skip planning and use the fixed angle
 * override defined in ANGLE_PROMPTS.
 *
 * @param {number} [slotIndex=0] Slot 0 = planned. Slots 1–3 force a distinct angle.
 */
export async function generateMicroCard({ prompt_text, expected_answer_text, subject, concept, user_answer = '', slotIndex = 0 }) {
  const angleBlock = ANGLE_PROMPTS[slotIndex] ?? ANGLE_PROMPTS[ANGLE_PROMPTS.length - 1];
  const angleSection = angleBlock ? `\n${angleBlock}\n` : '';

  // For the primary card, plan first; sibling cards use fixed angles for diversity.
  let strategySection = '';
  if (slotIndex === 0) {
    const plan = await planMicroCard({ prompt_text, expected_answer_text, concept, user_answer });
    strategySection = `\nESTRATEGIA ELEGIDA: ${plan.strategy}
Diagnóstico del estudiante: ${plan.diagnosis}

${STRATEGY_GUIDE}\n`;
  }

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 200,
    temperature: 0,
    system: `Generás una sola micro-pregunta socrática de estudio.

OBJETIVO: ir a lo básico — querés saber si el estudiante entiende la idea mínima.
${strategySection}
REGLAS:
- Una sola pregunta. Corta. Lenguaje simple.
- No nombres el concepto que falta.
- No construyas escenarios complejos — usá el más básico posible.${angleSection}
FORMATO (dos líneas exactas, sin nada más):
PREGUNTA: <la pregunta>
RESPUESTA: <respuesta esperada, 1 oración>`,
    messages: [{
      role: 'user',
      content: `Tarjeta original:
Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Materia: ${subject || 'no especificada'}

Respuesta que dio el estudiante: "${user_answer || '(sin respuesta registrada)'}"

Concepto que el estudiante no demostró comprender: "${concept}"

Generá la micro-pregunta socrática.`
    }]
  });

  const raw = response.content.find((b) => b.type === 'text')?.text ?? '';

  const questionMatch = raw.match(/^PREGUNTA:\s*(.+)/im);
  const answerMatch   = raw.match(/^RESPUESTA:\s*([\s\S]+)/im);

  const question = questionMatch?.[1]?.trim()
    ? questionMatch[1].trim()
    : extractQuestion(raw) || `¿Qué es "${concept}" y por qué es importante?`;

  const expected_answer = answerMatch?.[1]?.trim() || expected_answer_text;

  return { question, expected_answer };
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

// ─── Code scaffold micro-cards ─────────────────────────────────────────────

/**
 * Analyse the student's code answer and decide what kind of scaffold to build.
 *
 * Returns:
 *   { seccionFallida, tipoScaffold, razon }
 *
 * tipoScaffold:
 *   COMPLETION — student wrote something but a specific section is wrong/missing
 *   STRUCTURE  — student left it blank or wrote something unrecognisable
 */
async function planCodeScaffoldMicroCard({ prompt_text, expected_answer_text, concept, user_answer }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 200,
    temperature: 0,
    system: `Sos un tutor experto en programación. Analizás la respuesta de código de un estudiante para planificar el mejor ejercicio de scaffolding.

TIPOS DE SCAFFOLD:
- COMPLETION: El estudiante escribió algo pero falló o dejó incompleta una sección específica (excepciones, condiciones, cursor, declaraciones, transacciones, bucle, etc.) → mostrarle el ejercicio resuelto excepto esa sección.
- STRUCTURE: El estudiante no escribió nada, escribió algo incoherente, o no se puede identificar qué parte falló → mostrarle un ejemplo minimal y completo de la estructura pedida.

Respondé SOLO en este formato (3 líneas, sin nada más):
SECCIÓN_FALLIDA: <parte del código que falló: excepciones | declaraciones | cursor | bucle | condición | transacción | estructura completa>
TIPO_SCAFFOLD: <COMPLETION|STRUCTURE>
RAZÓN: <por qué este scaffold, 1 oración>`,
    messages: [{
      role: 'user',
      content: `Ejercicio: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Respuesta del estudiante: "${user_answer || '(sin respuesta)'}"
Concepto no demostrado: "${concept}"`,
    }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const seccionMatch = text.match(/SECCIÓN_FALLIDA:\s*(.+)/i);
  const tipoMatch    = text.match(/TIPO_SCAFFOLD:\s*(\S+)/i);
  const razonMatch   = text.match(/RAZÓN:\s*(.+)/i);

  return {
    seccionFallida: seccionMatch?.[1]?.trim() ?? 'estructura completa',
    tipoScaffold:   tipoMatch?.[1]?.trim().toUpperCase() === 'COMPLETION' ? 'COMPLETION' : 'STRUCTURE',
    razon:          razonMatch?.[1]?.trim() ?? '',
  };
}

/**
 * Generate a scaffold micro-card for a code-related subject.
 *
 * Two-stage:
 *   1. planCodeScaffoldMicroCard — diagnoses which section failed and what scaffold type to use.
 *   2. This function — generates the actual scaffold exercise using the plan.
 *
 * Slot 0 (primary card): runs the planner first.
 * Slots 1–3 (sibling diversity cards): skip planning and use ANGLE_PROMPTS overrides.
 *
 * Output:
 *   question        — scaffold exercise (pre-solved code with a gap, or structure example + question)
 *   expected_answer — only the code for the missing/incorrect section
 */
export async function generateCodeScaffoldMicroCard({ prompt_text, expected_answer_text, subject, concept, user_answer = '', slotIndex = 0 }) {
  let planSection = '';

  if (slotIndex === 0) {
    const plan = await planCodeScaffoldMicroCard({ prompt_text, expected_answer_text, concept, user_answer });

    if (plan.tipoScaffold === 'COMPLETION') {
      planSection = `\nTIPO: COMPLETION
SECCIÓN A COMPLETAR: ${plan.seccionFallida}

INSTRUCCIONES DE GENERACIÓN:
- Tomá el tipo de ejercicio de la respuesta esperada (misma operación: UPDATE, cursor, procedure, etc.) pero usá datos/nombres diferentes y más simples.
- Presentá la mayor parte del código RESUELTO.
- Dejá SOLO la sección "${plan.seccionFallida}" sin resolver.
- Señalá claramente dónde completar con un comentario: -- [COMPLETAR: ${plan.seccionFallida}]
- No uses los mismos nombres de variables, tablas o columnas del ejercicio original.\n`;
    } else {
      planSection = `\nTIPO: STRUCTURE
SECCIÓN FALLIDA: ${plan.seccionFallida}

INSTRUCCIONES DE GENERACIÓN:
- El estudiante no logró demostrar la estructura básica requerida.
- Mostrá un ejemplo minimal y completo (10-15 líneas máximo) del tipo de código pedido.
- Usá datos/nombres simples y distintos al ejercicio original.
- Al final del ejemplo preguntá por qué se necesita la sección "${plan.seccionFallida}" o qué hace.\n`;
    }
  } else {
    const angleBlock = ANGLE_PROMPTS[slotIndex] ?? ANGLE_PROMPTS[ANGLE_PROMPTS.length - 1];
    if (angleBlock) planSection = `\n${angleBlock}\n`;
  }

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 500,
    temperature: 0,
    system: `Sos un tutor de programación que genera micro-ejercicios de completado para estudiantes.
${planSection}
REGLAS ESTRICTAS:
- PROHIBIDO usar nombres de variables, tablas, columnas o entidades del ejercicio original.
- Usá siempre datos simples y ficticios (empleados, productos, clientes, etc.).
- El código presentado debe ser sintácticamente correcto excepto por la sección marcada.
- La respuesta esperada debe ser SOLO el código de la sección faltante (sin repetir el resto).
- Máximo 20 líneas de código en el EJERCICIO.

FORMATO (exactamente estas dos etiquetas, sin nada más):
EJERCICIO:
<código del ejercicio con gap claramente marcado, o ejemplo minimal + pregunta al final>

RESPUESTA_ESPERADA:
<solo el código o explicación de la sección que el estudiante debe completar>`,
    messages: [{
      role: 'user',
      content: `Materia: ${subject || 'no especificada'}
Concepto que el estudiante no demostró: "${concept}"

[CONTEXTO — no reutilizar nombres ni detalles]
Ejercicio original: ${prompt_text}
Respuesta de referencia: ${expected_answer_text}
Respuesta del estudiante: "${user_answer || '(sin respuesta)'}"
[FIN CONTEXTO]

Generá el micro-ejercicio de scaffolding.`,
    }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const ejercicioMatch  = text.match(/EJERCICIO:\s*([\s\S]+?)(?=\nRESPUESTA_ESPERADA:|$)/i);
  const respuestaMatch  = text.match(/RESPUESTA_ESPERADA:\s*([\s\S]+)/i);

  const question        = ejercicioMatch?.[1]?.trim()  || `Completá la sección de "${concept}" en un bloque ${subject || 'de código'}.`;
  const expected_answer = respuestaMatch?.[1]?.trim()  || expected_answer_text;

  return { question, expected_answer };
}

/**
 * Remove gaps that are redundant before allocating microcard slots.
 * Two kinds of redundancy are removed:
 *   1. Gaps the student already addressed in their answer (even if phrased differently)
 *   2. Semantically duplicate gaps — where two entries target the same underlying concept
 *
 * Preserves the order of the input list (ranking should happen before this call).
 * Falls back to the original list on any error.
 */
export async function filterRedundantGaps({ prompt_text, expected_answer_text, user_answer = '', gaps }) {
  if (!gaps || gaps.length === 0) return gaps ?? [];
  // Single gap: only check if the student already covered it.
  // Multiple gaps: also deduplicate semantic overlaps.

  const numberedList = gaps.map((g, i) => `${i + 1}. ${g}`).join('\n');

  const prompt = `A student answered a flashcard. An evaluator identified the following concept gaps. Before creating study cards, you must filter this list.

## Card
- Question: ${prompt_text}
- Expected answer: ${expected_answer_text}
- Student's answer: "${user_answer || '(no answer provided)'}"

## Identified gaps (already ranked best-first)
${numberedList}

## Filtering rules (apply both)
1. REMOVE any gap the student already demonstrated in their answer — even if they used different words, synonyms, or a paraphrase. If the student showed they understand the idea, don't drill them on it.
2. REMOVE semantic duplicates — if two gaps target the same underlying concept from slightly different angles, keep only the first (highest-ranked) one and drop the rest.

KEEP only gaps that are (a) genuinely absent from the student's answer AND (b) conceptually distinct from every other kept gap.

## Output format
Return ONLY a JSON array of the gap strings to keep, preserving their order. Return [] if all are redundant. No explanation, no markdown fences.

Example output:
["gap 2 text", "gap 4 text"]`;

  try {
    const response = await getClient().messages.create({
      model:       LLM_MODEL,
      max_tokens:  256,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const text     = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
    const filtered = JSON.parse(text);

    if (!Array.isArray(filtered)) return gaps;

    const gapSet = new Set(gaps);
    return filtered.filter((g) => typeof g === 'string' && gapSet.has(g));
  } catch {
    return gaps;
  }
}
