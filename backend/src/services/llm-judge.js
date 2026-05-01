import Anthropic from '@anthropic-ai/sdk';
import { LLM_MODELS } from '../config/env.js';

const LLM_MODEL = LLM_MODELS.judge;
const LLM_MAX_TOKENS = 384;
const FEW_SHOT_LIMIT = 4;

// In-memory cache for few-shot examples per subject (TTL: 5 minutes).
const _fewShotCache = new Map();
const FEW_SHOT_CACHE_TTL_MS = 5 * 60 * 1000;

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

/** Map legacy DB grades to display grade for few-shot examples. */
function toDisplayGrade(g) {
  if (g === 'pass')   return 'GOOD';
  if (g === 'fail')   return 'AGAIN';
  if (g === 'review') return 'HARD';
  return String(g).toUpperCase();
}

/**
 * Fetch calibration examples from past human decisions.
 * Prefers examples for the same subject; falls back to any subject.
 * Returns a balanced set across grade levels.
 * Results are cached per subject for FEW_SHOT_CACHE_TTL_MS to avoid redundant DB queries.
 */
export async function fetchFewShotExamples(pool, subject) {
  const cacheKey = (subject || '').toLowerCase();
  const cached = _fewShotCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < FEW_SHOT_CACHE_TTL_MS) {
    return cached.examples;
  }

  const result = await pool.query(
    `SELECT
       ei.input_payload->>'prompt_text'          AS prompt_text,
       ei.input_payload->>'user_answer_text'      AS user_answer_text,
       ei.input_payload->>'expected_answer_text'  AS expected_answer_text,
       ud.final_grade,
       ud.reason
     FROM user_decisions ud
     JOIN evaluation_items ei ON ud.evaluation_item_id = ei.id
     WHERE ud.final_grade IN ('pass', 'fail', 'again', 'hard', 'good', 'easy')
       AND ud.decision_type IN ('accepted', 'corrected')
     ORDER BY
       (CASE WHEN lower(ei.input_payload->>'subject') = lower($1) THEN 0 ELSE 1 END),
       ud.decided_at DESC
     LIMIT $2`,
    [subject || '', FEW_SHOT_LIMIT * 2]
  );

  // Balance between pass-like and fail-like
  const passes = result.rows.filter((r) => ['pass', 'good', 'easy'].includes(r.final_grade));
  const fails  = result.rows.filter((r) => ['fail', 'again', 'hard'].includes(r.final_grade));
  const half   = Math.ceil(FEW_SHOT_LIMIT / 2);

  const examples = [
    ...passes.slice(0, half),
    ...fails.slice(0, FEW_SHOT_LIMIT - Math.min(passes.length, half))
  ].slice(0, FEW_SHOT_LIMIT);

  _fewShotCache.set(cacheKey, { examples, timestamp: Date.now() });
  return examples;
}

function buildStrictnessSection(strictness) {
  if (strictness <= 2) {
    return `
━━━ NIVEL DE EXIGENCIA: BÁSICA (${strictness}/10) ━━━
El docente configuró exigencia mínima. Evaluá con máxima generosidad:
• Si el estudiante demuestra que entiende el concepto central, asignale GOOD aunque le falten detalles secundarios.
• Usá HARD solo cuando falte un elemento verdaderamente indispensable para entender el tema.
• Usá AGAIN solo si la respuesta es completamente equivocada o totalmente irrelevante.
• Tolerá imprecisiones de vocabulario, omisiones de detalles, y formulaciones vagas o imprecisas.
• Ante la duda entre dos notas, elegí la más alta.`;
  }
  if (strictness <= 4) {
    return `
━━━ NIVEL DE EXIGENCIA: MODERADA (${strictness}/10) ━━━
Evaluá con generosidad pero sin resignar la comprensión del tema:
• GOOD si el estudiante cubre los puntos principales, aunque le falten detalles menores.
• HARD si falta un elemento importante pero la dirección conceptual es correcta.
• Tolerá paráfrasis y omisiones de detalles claramente secundarios.
• No es necesario vocabulario técnico exacto si la idea central es clara.
• Ante la duda entre HARD y GOOD, elegí GOOD.`;
  }
  if (strictness <= 6) {
    return `
━━━ NIVEL DE EXIGENCIA: ESTÁNDAR (${strictness}/10) ━━━
Aplicá los criterios base definidos arriba sin ajustes adicionales.`;
  }
  if (strictness <= 8) {
    return `
━━━ NIVEL DE EXIGENCIA: EXIGENTE (${strictness}/10) ━━━
El docente configuró alta exigencia. Aplicá criterios estrictos:
• GOOD solo si están presentes TODOS los elementos esenciales con formulación técnicamente precisa.
• HARD si el vocabulario técnico es impreciso o ambiguo, aunque la idea general sea correcta.
• HARD si falta cualquier elemento del expected answer, incluidos los secundarios.
• No tolerés vaguedades: frases como "algo así" o "más o menos" no alcanzan para GOOD.
• Ante la duda entre HARD y GOOD, siempre elegí HARD.
• Para EASY: la respuesta debe superar claramente lo esperado en profundidad técnica o amplitud.`;
  }
  // 9-10
  return `
━━━ NIVEL DE EXIGENCIA: MÁXIMA (${strictness}/10) ━━━
El docente configuró exigencia máxima. La regla es BINARIA: o la tarjeta está perfecta, o es AGAIN.
• HARD NO SE USA en este nivel. Está deshabilitado. No lo asignes bajo ninguna circunstancia.
• GOOD requiere: todos los elementos esenciales + vocabulario técnico preciso + formulación sin ambigüedades + ningún detalle importante omitido.
• Si algo falta, es impreciso, vago, o menciona una palabra similar pero no exacta → AGAIN directamente.
• AGAIN para cualquier respuesta que no sea técnicamente perfecta: imprecisiones, sinónimos inexactos, elementos faltantes, formulaciones ambiguas, todo es AGAIN.
• EASY solo para respuestas que claramente superan lo esperado en detalle, profundidad o amplitud.
• Ante la duda entre AGAIN y GOOD → AGAIN. Ante la duda entre GOOD y EASY → GOOD.
• Estándar de referencia: ¿la respuesta es técnicamente perfecta tal como está? Si tenés cualquier duda → AGAIN.`;
}

function buildSystemPrompt(examples, strictness = 5, gradingRubric = []) {
  let system = `Sos un evaluador académico calibrado. Tu tarea es clasificar la respuesta del estudiante en uno de 4 niveles.

Respondé ÚNICAMENTE con este formato exacto (tres líneas, sin texto adicional):
GRADE: AGAIN|HARD|GOOD|EASY
JUSTIFICATION: <una oración breve en español>
MISSING: <concepto1>, <concepto2> | NONE

━━━ CRITERIOS BASE ━━━

▸ AGAIN — Sin respuesta útil o error conceptual grave.
  Usá AGAIN cuando:
  • Respondió "no sé", dejó en blanco o escribió texto irrelevante al concepto pedido
  • La respuesta contradice directamente el concepto esperado (ej: define algo como lo opuesto de lo que es)
  • No hay ningún elemento correcto de los elementos esenciales requeridos
  • El estudiante solo reescribió o parafraseó el enunciado sin aportar ningún desarrollo ni solución (ej: copió la ecuación o la pregunta tal cual sin resolverla)
  Ejemplo: "¿Qué es un cursor en PL/SQL?" → "es una tabla temporal" → AGAIN (error conceptual grave)
  Ejemplo: "Resolvé dy/dx + y/x = x^3" → "dy/dx + y/x = x^3" → AGAIN (solo copió el enunciado)

▸ HARD — Idea general correcta, pero le faltan detalles técnicos críticos.
  Usá HARD cuando:
  • La dirección o tema del concepto es correcto
  • Pero falta al menos 1 elemento técnico obligatorio presente en la respuesta esperada
  • O la respuesta es tan vaga que en un parcial sacaría entre 4 y 6 sobre 10
  • O nombró el concepto pero no pudo explicar cómo funciona o para qué sirve
  Ejemplo: "¿Qué hace COMMIT?" → "guarda los cambios" → HARD (falta: permanencia, liberación de locks)

▸ GOOD — Respuesta correcta con todos los elementos esenciales presentes.
  Usá GOOD cuando:
  • Todos los elementos esenciales de la respuesta esperada están presentes (en cualquier orden)
  • No hay errores conceptuales (errores de ortografía, redacción o concisión no cuentan)
  Tolerá sin penalizar: sinónimos, paráfrasis, respuesta más larga, orden diferente, ejemplos explicativos,
  omisión de detalles no esenciales. Regla de desempate: si dudás entre HARD y GOOD, elegí HARD.
  Ejemplo: "¿Qué es un cursor?" → "puntero que recorre fila a fila el resultado de un SELECT en PL/SQL" → GOOD

▸ EASY — Respuesta perfecta que va más allá del mínimo requerido.
  Usá EASY cuando cumple GOOD más al menos UNO de:
  • Dio un ejemplo concreto que demuestra comprensión profunda (no solo memorización)
  • Conectó el concepto con otro tema relacionado correctamente
  • Explicó el "por qué" o "para qué" del concepto (no solo el "qué")
  • Anticipó un caso edge, limitación o excepción del concepto
  • La respuesta fue notablemente más precisa o completa que la esperada
  Regla de desempate: si dudás entre GOOD y EASY, elegí GOOD. EASY es solo para respuestas claramente superiores.

Para MISSING: listá los conceptos o ideas específicas que faltan o están incorrectos. Usá NONE si no falta nada relevante. Máximo 3 conceptos, sin oraciones largas.

━━━ RESPUESTAS ESPERADAS EN FORMATO BULLET ━━━
Cuando la respuesta esperada está en formato de lista (bullets con "-" o "•"):
• Cada bullet representa un CONCEPTO o característica, NO una formulación literal obligatoria.
• El estudiante PUEDE expresar cada concepto con sus propias palabras, sinónimos o paráfrasis — esto cuenta como correcto si la idea es equivalente.
• NO penalices diferencias de vocabulario cuando la idea subyacente es la misma.
  Ejemplos de equivalencias válidas:
  "persiste los cambios en disco" ≡ "guarda permanentemente los datos"
  "libera los bloqueos" ≡ "libera los locks de la transacción"
  "previene accesos concurrentes" ≡ "bloquea el acceso simultáneo de otros procesos"
• Para GOOD: el estudiante debe cubrir los conceptos principales. Si hay 4-5 bullets breves en la respuesta esperada, cubrir 3-4 de los conceptos con buena precisión conceptual alcanza para GOOD; no es necesario mencionar cada detalle secundario.
• Para AGAIN/HARD: solo cuando falten conceptos verdaderamente centrales, no cuando el estudiante usó palabras distintas para el mismo concepto.`;

  if (gradingRubric.length > 0) {
    system += `

━━━ RÚBRICA DE CORRECCIÓN (elementos mínimos para aprobar) ━━━
Esta rúbrica define exactamente qué debe estar presente para GOOD. Usala como criterio principal; la respuesta esperada es contexto adicional.
${gradingRubric.map((r) => `• ${r}`).join('\n')}
Para GOOD: la respuesta del estudiante debe cubrir los puntos de la rúbrica (puede usar sinónimos o paráfrasis). Los detalles de la respuesta esperada que NO aparecen en la rúbrica son opcionales.`;
  }

  system += buildStrictnessSection(strictness);

  if (examples.length > 0) {
    system += '\n\n━━━ EJEMPLOS DE CALIBRACIÓN ━━━\n';
    for (const ex of examples) {
      system += `
---
Pregunta: ${ex.prompt_text}
Respuesta esperada: ${ex.expected_answer_text}
Respuesta del estudiante: ${ex.user_answer_text}
Calificación: ${toDisplayGrade(ex.final_grade)}`;
      if (ex.reason) {
        system += `\nMotivo: ${ex.reason}`;
      }
    }
    system += '\n---';
  }

  return system;
}

// Map legacy grades that may come from old LLM outputs or DB
const LEGACY_GRADE_MAP = { PASS: 'GOOD', FAIL: 'AGAIN', REVIEW: 'HARD' };
const VALID_GRADES = new Set(['AGAIN', 'HARD', 'GOOD', 'EASY']);

function parseResponse(text) {
  // Normalise line endings, strip surrounding whitespace, discard blank lines.
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n').map((l) => l.trim()).filter(Boolean);

  // Locate the three expected label lines regardless of extra blank lines inserted by the model.
  const gradeLine   = lines.find((l) => /^GRADE:/i.test(l));
  const justLine    = lines.find((l) => /^JUSTIFICATION:/i.test(l));
  const missingLine = lines.find((l) => /^MISSING:/i.test(l));

  if (!gradeLine) {
    throw new Error(`LLM judge: cannot parse grade from response: "${text.slice(0, 200)}"`);
  }

  const raw   = gradeLine.replace(/^GRADE:\s*/i, '').trim().toUpperCase();
  const grade = LEGACY_GRADE_MAP[raw] || raw;

  if (!VALID_GRADES.has(grade)) {
    throw new Error(`LLM judge: unexpected grade value "${grade}" in: "${text.slice(0, 200)}"`);
  }

  const justification = justLine
    ? (justLine.replace(/^JUSTIFICATION:\s*/i, '').trim() || 'Evaluación automática.')
    : 'Evaluación automática.';

  let missing_concepts = [];
  if (missingLine) {
    const rawMissing = missingLine.replace(/^MISSING:\s*/i, '').trim();
    if (rawMissing.toUpperCase() !== 'NONE') {
      // Cap at 5 to guard against runaway comma-separated lists.
      missing_concepts = rawMissing.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5);
    }
  }

  return { suggested_grade: grade, justification, missing_concepts };
}

/**
 * Evaluate a student answer using an LLM calibrated with past human decisions.
 *
 * @param {object} pool  - pg Pool (or PoolClient) for fetching few-shot examples
 * @param {object} payload - { prompt_text, user_answer_text, expected_answer_text, subject, strictness }
 * @returns {{ suggested_grade, justification, few_shot_count, model }}
 */
export async function judgeWithLLM(pool, { prompt_text, user_answer_text, expected_answer_text, subject, strictness = 5, grading_rubric = [] }) {
  const examples = await fetchFewShotExamples(pool, subject);

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: LLM_MAX_TOKENS,
    temperature: 0,
    system: buildSystemPrompt(examples, strictness, grading_rubric),
    messages: [{
      role: 'user',
      content: `Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Respuesta del estudiante: ${user_answer_text}`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  if (!text.trim()) {
    throw new Error('LLM judge: received empty response from model');
  }
  const parsed = parseResponse(text);

  return {
    ...parsed,
    few_shot_count: examples.length,
    model: LLM_MODEL,
    missing_concepts: parsed.missing_concepts
  };
}
