import Anthropic from '@anthropic-ai/sdk';

const LLM_MODEL = 'claude-haiku-4-5';
const DEFAULT_RESPONSE_TIME_MS = 45000;

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Plans an optimal study session using an LLM agent.
 *
 * @param {object} params
 * @param {number} params.availableMinutes
 * @param {string} params.energyLevel - 'tired' | 'normal' | 'focused'
 * @param {Array}  params.cards - overdue cards with metadata
 * @param {Array}  params.microCards - overdue micro-cards
 * @param {Array}  params.subjectConfigs - [{ subject, exam_date, exam_type }]
 * @param {number|null} params.avgResponseTimeMs
 * @returns {Promise<object>} plan with planned, deferred, total_estimated_minutes, session_tip, warnings
 */
export async function planSession({
  availableMinutes,
  energyLevel,
  cards,
  microCards,
  subjectConfigs,
  avgResponseTimeMs
}) {
  const baseResponseMs = avgResponseTimeMs ?? DEFAULT_RESPONSE_TIME_MS;

  const userContent = buildUserMessage({
    availableMinutes,
    energyLevel,
    cards,
    microCards,
    subjectConfigs,
    baseResponseMs
  });

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 1000,
    temperature: 0,
    system: `Sos un tutor que organiza sesiones de estudio óptimas.
Dado el tiempo disponible, el estado del estudiante y las tarjetas pendientes, armás un plan realista.

Reglas:
- Tiempo por tarjeta estimado: usa avg_response_time_ms como base. Si energyLevel='tired' multiplicá por 1.4. Si 'focused' multiplicá por 0.85.
- Siempre incluí primero las micro-tarjetas (son remediales, alta prioridad).
- Luego tarjetas con examen próximo (< 7 días) ordenadas por urgencia.
- Luego tarjetas con active_micro_count > 0 (tienen conceptos pendientes).
- Luego el resto por fecha de vencimiento.
- Si no entran todas, cortá la lista y marcá las descartadas.
- Si energyLevel='tired': máximo 60% del tiempo disponible en material nuevo.
- Si energyLevel='focused': podés incluir hasta 110% del tiempo (el estudiante puede rendir más).

Respondé ÚNICAMENTE con JSON válido:
{
  "planned": [
    { "type": "micro"|"card", "id": <number>, "subject": "...", "estimated_ms": <number>, "reason": "..." },
    ...
  ],
  "deferred": [
    { "type": "micro"|"card", "id": <number>, "subject": "..." },
    ...
  ],
  "total_estimated_minutes": <number>,
  "session_tip": "<consejo corto para esta sesión según el estado de ánimo>",
  "warnings": ["<advertencia si hay examen muy próximo>", ...]
}`,
    messages: [{
      role: 'user',
      content: userContent
    }]
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';

  // Strip markdown code fences if present
  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  try {
    return JSON.parse(jsonText);
  } catch (err) {
    console.error('[session-planner] Failed to parse LLM response:', text);
    throw new Error('El agente devolvió una respuesta inválida. Intentá de nuevo.');
  }
}

function buildUserMessage({ availableMinutes, energyLevel, cards, microCards, subjectConfigs, baseResponseMs }) {
  const now = new Date();

  // Build a lookup for subject configs
  const configBySubject = {};
  for (const cfg of subjectConfigs) {
    configBySubject[cfg.subject] = cfg;
  }

  // Compute days until exam for each subject
  function daysUntilExam(subject) {
    const cfg = configBySubject[subject];
    if (!cfg?.exam_date) return null;
    const examDate = new Date(cfg.exam_date);
    const diffMs = examDate - now;
    return Math.ceil(diffMs / 86400000);
  }

  const microSummary = microCards.map((m) => ({
    id: m.id,
    type: 'micro',
    concept: m.concept,
    parent_subject: m.parent_subject,
    days_until_exam: daysUntilExam(m.parent_subject)
  }));

  const cardSummary = cards.map((c) => ({
    id: c.id,
    type: 'card',
    subject: c.subject,
    interval_days: c.interval_days,
    pass_count: c.pass_count,
    review_count: c.review_count,
    active_micro_count: parseInt(c.active_micro_count) || 0,
    days_until_exam: daysUntilExam(c.subject)
  }));

  return `Planificá una sesión de estudio con los siguientes datos:

available_minutes: ${availableMinutes}
energy_level: ${energyLevel}
avg_response_time_ms: ${baseResponseMs}

micro_cards pendientes (${microSummary.length}):
${JSON.stringify(microSummary, null, 2)}

cards pendientes (${cardSummary.length}):
${JSON.stringify(cardSummary, null, 2)}

Devolvé únicamente el JSON del plan.`;
}
