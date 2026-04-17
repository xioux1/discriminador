import Anthropic from '@anthropic-ai/sdk';
import { LLM_MODELS } from '../config/env.js';

const LLM_MODEL        = LLM_MODELS.micro;
const LLM_MODEL_STRONG = LLM_MODELS.socratic; // Sonnet — for check-error micro-cards

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

function isChineseContext(subject, ...texts) {
  if (subject && /chino/i.test(subject)) return true;
  const hanzi = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  return texts.some((t) => t && hanzi.test(t));
}

/**
 * Chinese-specific micro-card generator.
 *
 * Two card types:
 *   VOCABULARY  — student didn't know a word/expression
 *                 Front: "¿Cómo se dice '[concept]' en chino?"
 *                 Back:  汉字 (pīnyīn)
 *
 *   STRUCTURE   — student forgot a grammar pattern, particle, measure word, etc.
 *                 Front: sentence with [___] gap + short Spanish instruction
 *                 Back:  missing element + brief explanation
 */
async function generateChineseMicroCard({ prompt_text, expected_answer_text, subject, concept, user_answer = '' }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 350,
    temperature: 0,
    system: `Sos un tutor de chino mandarín que genera micro-tarjetas de estudio de recall activo.

El estudiante no recordó un concepto puntual. Generá UNA micro-tarjeta según el tipo que corresponda.

═══ TIPO VOCABULARIO ═══
Cuando el concepto faltante es una palabra, sustantivo, verbo, adjetivo o expresión léxica:
  → QUESTION: ¿Cómo se dice "[concepto en español]" en chino?
  → ANSWER:   汉字 (pīnyīn) — sin traducción extra, solo el término chino con pinyin

═══ TIPO ESTRUCTURA/GRAMÁTICA ═══
Cuando el concepto faltante es una partícula (了/着/过/把/被/呢/吧…), patrón gramatical, medidor, orden de palabras, o estructura:
  → QUESTION: una oración en chino con [___] donde va el elemento faltante, seguida de una instrucción breve en español que explique qué completar
  → La oración debe ser simple, sin jerga técnica, y AUTOCONTENIDA (no requiere ver la tarjeta original)
  → ANSWER:   el elemento faltante + pinyin + explicación en 1 línea de por qué se usa ahí
  → Ejemplo de QUESTION: 他 ___ 学了三年汉语。 → Completá con la partícula/adverbio que indica que la acción ya ocurrió antes del presente.
  → Ejemplo de ANSWER: 已经 (yǐjīng) — indica que la acción se completó antes del momento de habla.

═══ CÓMO DECIDIR ═══
- palabra/expresión léxica → TIPO VOCABULARIO
- partícula, estructura, patrón gramatical, orden, medidor, tono → TIPO ESTRUCTURA/GRAMÁTICA
- Si hay dudas, preferí TIPO ESTRUCTURA si el concept menciona partícula/estructura/patrón.

═══ REGLAS UNIVERSALES ═══
- La ANSWER siempre incluye caracteres chinos + pinyin entre paréntesis.
- La QUESTION nunca revela la respuesta.
- No referencias a "la tarjeta original", "el ejercicio", "aquí".
- Si el contexto tiene una oración de ejemplo útil, podés adaptarla para el hueco.

Respondé ÚNICAMENTE en este formato (dos líneas):
QUESTION: <frente de la micro-tarjeta>
ANSWER: <dorso de la micro-tarjeta>`,
    messages: [{
      role: 'user',
      content: `Tarjeta original:
Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Materia: ${subject || 'Chino'}

Respuesta que dio el estudiante: "${user_answer || '(sin respuesta registrada)'}"

Concepto que el estudiante no demostró recordar: "${concept}"

Determiná el tipo (VOCABULARIO o ESTRUCTURA) y generá la micro-tarjeta.`,
    }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const questionMatch = text.match(/QUESTION:\s*(.+)/i);
  const answerMatch   = text.match(/ANSWER:\s*([\s\S]+)/i);

  return {
    question:        questionMatch?.[1]?.trim() ?? `¿Cómo se dice "${concept}" en chino?`,
    expected_answer: answerMatch?.[1]?.trim()   || expected_answer_text,
  };
}

/**
 * Chinese-specific micro-card from a binary check error.
 */
async function generateChineseMicroCardFromCheckError({ prompt_text, expected_answer_text, subject, error_label, user_answer = '' }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL_STRONG,
    max_tokens: 400,
    temperature: 0,
    system: `Sos un tutor de chino mandarín que genera micro-tarjetas a partir de errores conceptuales.

El estudiante cometió un error. Generá UNA micro-tarjeta que remedie exactamente ese error.

═══ TIPOS ═══

TIPO VOCABULARIO — confundió o no sabía una palabra:
  → QUESTION: ¿Cuál es la diferencia entre [término A] y [término B] en chino? o ¿Cuándo se usa [término] en vez de [otro]?
  → ANSWER: explicación breve + ambos términos en chino con pinyin

TIPO ESTRUCTURA/GRAMÁTICA — usó mal una partícula, estructura o patrón:
  → QUESTION: oración en chino con [___] donde va el elemento correcto, más instrucción en español indicando qué error cometió el estudiante para que lo corrija
  → ANSWER: elemento correcto + pinyin + por qué es incorrecto lo que usó el estudiante

TIPO CONCEPTO GENERAL — error de comprensión (orden, condición invertida, confusión de concepto):
  → QUESTION: pregunta directa en español sobre el concepto general, sin citar el ejercicio
  → ANSWER: respuesta conceptual con ejemplos en chino si aplica

═══ REGLAS ═══
- NUNCA citar variables, tablas, nombres propios del ejercicio original.
- NUNCA referenciar "el ejercicio", "el código", "aquí".
- La ANSWER siempre incluye caracteres chinos + pinyin si corresponde.
- La QUESTION no puede revelar la respuesta.

Respondé ÚNICAMENTE en este formato:
QUESTION: <frente>
ANSWER: <dorso>`,
    messages: [{
      role: 'user',
      content: `Materia: ${subject || 'Chino'}
Error conceptual detectado: "${error_label}"

[CONTEXTO INTERNO — no usar nombres ni detalles de esto en la pregunta]
Ejercicio original: ${prompt_text}
Respuesta de referencia: ${expected_answer_text}
Respuesta del estudiante: "${user_answer || '(no disponible)'}"
[FIN CONTEXTO INTERNO]

Determiná el tipo y generá la micro-tarjeta que ataque el error general, sin mencionar nada del ejercicio original.`,
    }],
  });

  const text          = response.content.find((b) => b.type === 'text')?.text ?? '';
  const questionMatch = text.match(/QUESTION:\s*(.+)/i);
  const answerMatch   = text.match(/ANSWER:\s*([\s\S]+)/i);

  return {
    question:        questionMatch?.[1]?.trim() ?? `¿Cómo se aplica correctamente: "${error_label}" en chino?`,
    expected_answer: answerMatch?.[1]?.trim()   || expected_answer_text,
  };
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
  if (isChineseContext(subject, expected_answer_text, prompt_text)) {
    return generateChineseMicroCard({ prompt_text, expected_answer_text, subject, concept, user_answer });
  }

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
  if (isChineseContext(subject, expected_answer_text, prompt_text)) {
    return generateChineseMicroCardFromCheckError({ prompt_text, expected_answer_text, subject, error_label, user_answer });
  }

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
