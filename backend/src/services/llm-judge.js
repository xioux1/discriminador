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
• GOOD si el estudiante cubre los puntos principales.
• HARD si falta un elemento importante pero la dirección conceptual es correcta.
• Tolerá paráfrasis y omisiones de detalles claramente secundarios.
• No es necesario vocabulario técnico exacto.
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
  ATENCIÓN — NO usés AGAIN cuando la respuesta describe correctamente la idea central del concepto aunque le falte la notación formal, la fórmula exacta o detalles técnicos secundarios. Una descripción conceptualmente correcta siempre vale al menos HARD.
  Ejemplo: "¿Qué es un cursor en PL/SQL?" → "es una tabla temporal" → AGAIN (error conceptual grave)
  Ejemplo: "Resolvé dy/dx + y/x = x^3" → "dy/dx + y/x = x^3" → AGAIN (solo copió el enunciado)
  Contraejemplo — NO AGAIN: "¿Cómo se calcula la derivada vectorial?" → "se calcula componente por componente en cada eje" → NO es AGAIN, es HARD (idea correcta, falta la expresión formal)

▸ HARD — Idea general correcta, pero le faltan detalles técnicos críticos.
  Usá HARD cuando:
  • La dirección o tema del concepto es correcto
  • Pero falta al menos 1 elemento técnico obligatorio presente en la respuesta esperada
  • O la respuesta es tan vaga que en un parcial sacaría entre 4 y 6 sobre 10
  • O nombró el concepto pero no pudo explicar cómo funciona o para qué sirve
  • O la respuesta es notablemente más corta que la respuesta esperada y omite partes sustanciales del desarrollo (ej: escribió un solo paso de un proceso de varios pasos)
  • O la respuesta esperada incluye una expresión formal (fórmula, notación matemática) pero el estudiante solo describió el mecanismo con palabras correctas sin escribir la expresión
  REGLA CRÍTICA — respuestas muy cortas: si la respuesta del estudiante tiene muy pocas palabras/caracteres comparada con la respuesta esperada (por ejemplo, 1-5 palabras vs un desarrollo de varios pasos), NO asumas que el resto estaba implícito. Esa brevedad indica desarrollo incompleto → HARD como mínimo, AGAIN solo si la idea central es incorrecta o el estudiante no aportó ningún elemento conceptualmente válido.
  Ejemplo: "¿Qué hace COMMIT?" → "guarda los cambios" → HARD (falta: permanencia, liberación de locks)
  Ejemplo: integral doble con cambio de orden → "x=√y" → HARD (solo escribió un límite, falta todo el desarrollo del cambio de orden y el cálculo)
  Ejemplo: "¿Cómo se calcula la derivada de una función vectorial?" → "el teorema dice que se calcula término por término en cada eje" → HARD (idea correcta: derivación componente por componente; falta la expresión formal r'(t) = f'(t)i + g'(t)j + h'(t)k y la condición de derivabilidad)

▸ GOOD — Respuesta correcta con todos los elementos esenciales presentes.
  Usá GOOD cuando:
  • Todos los elementos esenciales de la respuesta esperada están presentes (en cualquier orden)
  • No hay errores conceptuales (errores de ortografía, redacción o concisión no cuentan)
  • La extensión de la respuesta es razonablemente proporcional a lo que se pide (una respuesta de 1-3 palabras NO puede cubrir todos los elementos esenciales de un desarrollo de varios pasos)
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
• Para AGAIN/HARD: solo cuando falten conceptos verdaderamente centrales, no cuando el estudiante usó palabras distintas para el mismo concepto.

━━━ RESPUESTAS ESPERADAS CON EXPRESIÓN FORMAL O FÓRMULA ━━━
Cuando la respuesta esperada contiene una expresión matemática formal, notación vectorial, fórmula o ecuación:
• Si la pregunta NO pide explícitamente "escribir la expresión", "dar la fórmula" o "escribir la notación", la expresión formal es REFERENCIA, no obligación literal.
• Una descripción verbal correcta del mecanismo o concepto (ej: "se deriva componente por componente") cuenta como elemento esencial presente.
• Falta de notación formal cuando la idea es correcta → HARD, nunca AGAIN.
• Solo exigí la expresión literal si la pregunta dice explícitamente "escribir la fórmula", "dar la expresión", "usar notación vectorial", etc.
  Ejemplo: "¿Cómo se calcula la derivada de r(t)?" → respuesta esperada con r'(t) = f'(t)i + g'(t)j + h'(t)k → el estudiante dice "se deriva cada componente por separado" → HARD (no AGAIN: la idea es correcta, falta la expresión).

━━━ EQUIVALENCIA MATEMÁTICA EN RESULTADOS NUMÉRICOS O ALGEBRAICOS ━━━
Cuando la pregunta pide calcular, resolver o evaluar (integral, derivada, límite, ecuación, etc.):
• La respuesta esperada define el VALOR correcto, no la forma obligatoria de expresarlo.
• Representaciones distintas del mismo valor son EQUIVALENTES y deben aceptarse como correctas:
  - Forma exacta ≡ aproximación decimal razonablemente precisa (ej: 2ln(2) - ln(3) ≡ 0.29 ≈ 0.288)
  - Forma factorizada ≡ forma expandida
  - Fracción ≡ decimal equivalente
  - Forma logarítmica ≡ forma exponencial ≡ forma numérica
• NO penalices por la forma de representación a menos que la pregunta diga EXPLÍCITAMENTE:
  "expresá en forma exacta", "dejá en forma logarítmica", "no uses decimales", "simplificá", etc.
• Para aproximaciones decimales: aceptá si el error es de redondeo razonable (1-2 cifras significativas de diferencia).
  Ejemplo: respuesta esperada 2ln(2) - ln(3) ≈ 0.2986 → estudiante escribe 0.29 o 0.30 → GOOD si el proceso fue correcto.
  Ejemplo: respuesta esperada π/4 ≈ 0.785 → estudiante escribe 0.79 → no penalices por redondeo.
• HARD (no GOOD) solo si la forma alternativa oculta errores conceptuales o el valor numérico difiere significativamente.
• Si la consigna no especifica la forma del resultado, el estudiante puede elegir cualquier representación válida.

━━━ PASOS INTERMEDIOS IMPLÍCITOS EN DESARROLLOS ALGEBRAICOS ━━━
Cuando la respuesta esperada narra explícitamente cada paso de una derivación (ej: "De x = √t se obtiene t = x²"), pero la respuesta del estudiante muestra el resultado de ese paso sin narrarlo:
• Si el resultado del paso aparece en la respuesta del estudiante (ej: escribió "t = x²"), el paso se considera PRESENTE aunque el estudiante no haya explicado cómo lo obtuvo.
• La narración de un paso obvio de un solo movimiento algebraico (despejar, sustituir, elevar al cuadrado, pasar un término) NO es un elemento esencial por sí misma — lo esencial es el resultado.
• Solo penalizá la ausencia del paso si el resultado del mismo también está ausente de la respuesta.
  Ejemplo: respuesta esperada "De x = √t se obtiene t = x²; se sustituye en y = 2 - t → y = 2 - x²" → estudiante escribe "t = x², y = 2 - x²" → GOOD (ambos resultados están presentes).
  Contraejemplo: respuesta esperada incluye t = x² → estudiante escribe directamente y = 2 - x² sin mostrar t = x² → ese resultado sí está ausente → puede justificar HARD.`;

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

function buildBlindSystemPrompt(strictness = 5) {
  let system = `Sos un evaluador académico. Tu tarea es calificar la respuesta del estudiante a la pregunta dada, basándote ÚNICAMENTE en tu conocimiento del tema. No tenés respuesta de referencia: evaluás por lo que sabés del tema.

Respondé ÚNICAMENTE con este formato exacto (tres líneas, sin texto adicional):
GRADE: AGAIN|HARD|GOOD|EASY
JUSTIFICATION: <una oración breve en español>
MISSING: <concepto1>, <concepto2> | NONE

━━━ CRITERIOS ━━━

▸ AGAIN — Sin respuesta útil o error conceptual grave.
▸ HARD — Idea general correcta pero faltan detalles técnicos críticos o la respuesta es vaga.
▸ GOOD — Respuesta correcta con los elementos esenciales presentes según tu conocimiento del tema.
▸ EASY — Respuesta que va más allá del mínimo requerido: da ejemplos, conecta conceptos, explica el "por qué".

Si la pregunta es muy específica de un dominio y no podés evaluar con certeza, preferí HARD antes que AGAIN.
Para MISSING: listá conceptos que faltan o están incorrectos. Usá NONE si no falta nada. Máximo 3 conceptos.`;

  system += buildStrictnessSection(strictness);
  return system;
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

/**
 * Evaluate a student answer without a reference/expected answer.
 * Judges purely based on the model's knowledge of the subject.
 *
 * @param {object} payload - { prompt_text, user_answer_text, strictness }
 * @returns {{ suggested_grade, justification, missing_concepts, model }}
 */
export async function judgeWithLLMBlind({ prompt_text, user_answer_text, strictness = 5 }) {
  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: LLM_MAX_TOKENS,
    temperature: 0,
    system: buildBlindSystemPrompt(strictness),
    messages: [{
      role: 'user',
      content: `Pregunta: ${prompt_text}\nRespuesta del estudiante: ${user_answer_text}`
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  if (!text.trim()) {
    throw new Error('LLM blind judge: received empty response from model');
  }
  const parsed = parseResponse(text);

  return {
    ...parsed,
    model: LLM_MODEL,
    missing_concepts: parsed.missing_concepts
  };
}
