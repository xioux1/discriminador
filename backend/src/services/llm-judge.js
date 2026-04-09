import Anthropic from '@anthropic-ai/sdk';

// claude-haiku-4-5: optimized for latency — classification task with short output.
const LLM_MODEL = 'claude-haiku-4-5';
const LLM_MAX_TOKENS = 384;
const FEW_SHOT_LIMIT = 4;

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
 */
export async function fetchFewShotExamples(pool, subject) {
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

  return [
    ...passes.slice(0, half),
    ...fails.slice(0, FEW_SHOT_LIMIT - Math.min(passes.length, half))
  ].slice(0, FEW_SHOT_LIMIT);
}

function buildSystemPrompt(examples) {
  let system = `Sos un evaluador académico calibrado. Tu tarea es clasificar la respuesta del estudiante en uno de 4 niveles.

Respondé ÚNICAMENTE con este formato exacto (tres líneas, sin texto adicional):
GRADE: AGAIN|HARD|GOOD|EASY
JUSTIFICATION: <una oración breve en español>
MISSING: <concepto1>, <concepto2> | NONE

━━━ CRITERIOS EXACTOS ━━━

▸ AGAIN — Sin respuesta útil o error conceptual grave.
  Usá AGAIN cuando:
  • Respondió "no sé", dejó en blanco o escribió texto irrelevante al concepto pedido
  • La respuesta contradice directamente el concepto esperado (ej: define algo como lo opuesto de lo que es)
  • No hay ningún elemento correcto de los elementos esenciales requeridos
  Ejemplo: "¿Qué es un cursor en PL/SQL?" → "es una tabla temporal" → AGAIN (error conceptual grave)

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
  omisión de detalles no esenciales. Regla: si dudás entre HARD y GOOD, elegí GOOD.
  Ejemplo: "¿Qué es un cursor?" → "puntero que recorre fila a fila el resultado de un SELECT en PL/SQL" → GOOD

▸ EASY — Respuesta perfecta que va más allá del mínimo requerido.
  Usá EASY cuando cumple GOOD más al menos UNO de:
  • Dio un ejemplo concreto que demuestra comprensión profunda (no solo memorización)
  • Conectó el concepto con otro tema relacionado correctamente
  • Explicó el "por qué" o "para qué" del concepto (no solo el "qué")
  • Anticipó un caso edge, limitación o excepción del concepto
  • La respuesta fue notablemente más precisa o completa que la esperada
  Regla: si dudás entre GOOD y EASY, elegí GOOD. EASY es para respuestas claramente superiores.

Para MISSING: listá los conceptos o ideas específicas que faltan o están incorrectos. Usá NONE si no falta nada relevante. Máximo 3 conceptos, sin oraciones largas.`;

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
  const gradeMatch   = text.match(/GRADE:\s*(AGAIN|HARD|GOOD|EASY|PASS|FAIL|REVIEW)/i);
  const justMatch    = text.match(/JUSTIFICATION:\s*(.+)/i);
  const missingMatch = text.match(/MISSING:\s*(.+)/i);

  if (!gradeMatch) {
    throw new Error(`LLM judge: cannot parse grade from response: "${text}"`);
  }

  const raw = gradeMatch[1].toUpperCase();
  const grade = LEGACY_GRADE_MAP[raw] || raw;

  if (!VALID_GRADES.has(grade)) {
    throw new Error(`LLM judge: unexpected grade value "${grade}"`);
  }

  let missing_concepts = [];
  if (missingMatch) {
    const rawMissing = missingMatch[1].trim();
    if (rawMissing.toUpperCase() !== 'NONE') {
      missing_concepts = rawMissing.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  return {
    suggested_grade: grade,
    justification: justMatch ? justMatch[1].trim() : 'Evaluación automática.',
    missing_concepts
  };
}

/**
 * Evaluate a student answer using an LLM calibrated with past human decisions.
 *
 * @param {object} pool  - pg Pool (or PoolClient) for fetching few-shot examples
 * @param {object} payload - { prompt_text, user_answer_text, expected_answer_text, subject }
 * @returns {{ suggested_grade, justification, few_shot_count, model }}
 */
export async function judgeWithLLM(pool, { prompt_text, user_answer_text, expected_answer_text, subject }) {
  const examples = await fetchFewShotExamples(pool, subject);

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: LLM_MAX_TOKENS,
    temperature: 0,
    system: buildSystemPrompt(examples),
    messages: [{
      role: 'user',
      content: `Pregunta: ${prompt_text}
Respuesta esperada: ${expected_answer_text}
Respuesta del estudiante: ${user_answer_text}`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const parsed = parseResponse(text);

  return {
    ...parsed,
    few_shot_count: examples.length,
    model: LLM_MODEL,
    missing_concepts: parsed.missing_concepts
  };
}
