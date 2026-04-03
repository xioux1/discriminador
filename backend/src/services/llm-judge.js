import Anthropic from '@anthropic-ai/sdk';

// claude-haiku-4-5: optimized for latency — classification task with short output.
// Swap to claude-opus-4-6 if you need deeper reasoning on ambiguous cases.
const LLM_MODEL = 'claude-haiku-4-5';
const LLM_MAX_TOKENS = 256;
const FEW_SHOT_LIMIT = 4;

let _client = null;

function getClient() {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

/**
 * Fetch calibration examples from past human decisions.
 * Prefers examples for the same subject; falls back to any subject.
 * Returns a balanced set of PASS and FAIL cases.
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
     WHERE ud.final_grade IN ('pass', 'fail')
       AND ud.decision_type IN ('accepted', 'corrected')
     ORDER BY
       (CASE WHEN lower(ei.input_payload->>'subject') = lower($1) THEN 0 ELSE 1 END),
       ud.decided_at DESC
     LIMIT $2`,
    [subject || '', FEW_SHOT_LIMIT * 2]
  );

  const passes = result.rows.filter((r) => r.final_grade === 'pass');
  const fails  = result.rows.filter((r) => r.final_grade === 'fail');
  const half   = Math.ceil(FEW_SHOT_LIMIT / 2);

  return [
    ...passes.slice(0, half),
    ...fails.slice(0, FEW_SHOT_LIMIT - Math.min(passes.length, half))
  ].slice(0, FEW_SHOT_LIMIT);
}

function buildSystemPrompt(examples) {
  let system = `Sos un evaluador académico calibrado. Tu tarea es determinar si la respuesta del evaluado demuestra comprensión real del concepto pedido.

Respondé ÚNICAMENTE con este formato exacto (dos líneas, sin texto adicional):
GRADE: PASS|FAIL|REVIEW
JUSTIFICATION: <una oración breve en español>

Criterios de aprobación:
- PASS: el evaluado demuestra comprensión del concepto central, aunque use palabras distintas, orden diferente o más palabras que la respuesta esperada.
- FAIL: faltan conceptos esenciales o hay errores conceptuales graves.
- REVIEW: caso borderline que requiere validación docente.

NO penalizar bajo ninguna circunstancia:
- Respuesta más larga, verbal o conversacional que la esperada.
- Uso de sinónimos, paráfrasis o ejemplos para explicar el mismo concepto.
- Falta de concisión o de estructura de lista.
- Redacción típica de lenguaje hablado o dictado.

SÍ penalizar:
- Ausencia de la idea central del concepto.
- Errores conceptuales que contradigan la respuesta esperada.
- Enumeración vacía sin explicar el núcleo.`;

  if (examples.length > 0) {
    system += '\n\nEjemplos de calibración de este evaluador:\n';
    for (const ex of examples) {
      system += `
---
Pregunta: ${ex.prompt_text}
Respuesta esperada: ${ex.expected_answer_text}
Respuesta del evaluado: ${ex.user_answer_text}
Calificación: ${ex.final_grade.toUpperCase()}`;
      if (ex.reason) {
        system += `\nMotivo: ${ex.reason}`;
      }
    }
    system += '\n---';
  }

  return system;
}

function parseResponse(text) {
  const gradeMatch = text.match(/GRADE:\s*(PASS|FAIL|REVIEW)/i);
  const justMatch  = text.match(/JUSTIFICATION:\s*(.+)/i);

  if (!gradeMatch) {
    throw new Error(`LLM judge: cannot parse grade from response: "${text}"`);
  }

  const grade = gradeMatch[1].toUpperCase();
  if (!['PASS', 'FAIL', 'REVIEW'].includes(grade)) {
    throw new Error(`LLM judge: unexpected grade value "${grade}"`);
  }

  return {
    suggested_grade: grade,
    justification: justMatch ? justMatch[1].trim() : 'Evaluación automática.'
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
Respuesta del evaluado: ${user_answer_text}`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  const parsed = parseResponse(text);

  return {
    ...parsed,
    few_shot_count: examples.length,
    model: LLM_MODEL
  };
}
