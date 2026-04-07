import Anthropic from '@anthropic-ai/sdk';

const LLM_MODEL = 'claude-haiku-4-5';
const DEFAULT_RESPONSE_TIME_MS = 45000; // 45s default if no history

// Energy level parameters
const ENERGY = {
  tired:    { speedMultiplier: 1.4,  budgetMultiplier: 0.75 },
  normal:   { speedMultiplier: 1.0,  budgetMultiplier: 1.0  },
  focused:  { speedMultiplier: 0.85, budgetMultiplier: 1.1  },
};

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Plans an optimal study session.
 *
 * Architecture: LLM handles prioritization only (no math).
 * JS handles all time-budget arithmetic deterministically.
 *
 * @param {object} params
 * @param {number} params.availableMinutes
 * @param {string} params.energyLevel - 'tired' | 'normal' | 'focused'
 * @param {Array}  params.cards
 * @param {Array}  params.microCards
 * @param {Array}  params.subjectConfigs
 * @param {number|null} params.avgResponseTimeMs
 * @param {number}      params.calibrationFactor - personal correction factor (default 1.0)
 */
export async function planSession({
  availableMinutes,
  energyLevel,
  cards,
  microCards,
  subjectConfigs,
  avgResponseTimeMs,
  calibrationFactor = 1.0
}) {
  const energy = ENERGY[energyLevel] ?? ENERGY.normal;
  // Apply personal calibration factor: if user consistently takes longer, expand per-card estimate
  const baseMs  = (avgResponseTimeMs ?? DEFAULT_RESPONSE_TIME_MS) * calibrationFactor;

  // Deterministic time per card (JS, not LLM)
  const msPerCard    = Math.round(baseMs * energy.speedMultiplier);
  const budgetMs     = availableMinutes * 60 * 1000 * energy.budgetMultiplier;

  // Ask LLM only to prioritize — no math involved
  const prioritized = await getPrioritizedOrder({
    availableMinutes,
    energyLevel,
    cards,
    microCards,
    subjectConfigs,
    msPerCard,
  });

  // JS greedily fills the time budget from the prioritized list
  const allItems = buildItemMap(cards, microCards);
  const planned  = [];
  const deferred = [];
  let accumulatedMs = 0;
  const seen = new Set(); // dedup: LLM may return the same id twice

  for (const ref of prioritized) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = allItems.get(key);
    if (!item) continue;

    if (accumulatedMs + msPerCard <= budgetMs) {
      accumulatedMs += msPerCard;
      planned.push({
        type:         ref.type,
        id:           ref.id,
        subject:      item.subject || item.parent_subject,
        estimated_ms: msPerCard,
        reason:       ref.reason || '',
      });
    } else {
      deferred.push({ type: ref.type, id: ref.id, subject: item.subject || item.parent_subject });
    }
  }

  const totalEstimatedMinutes = parseFloat((accumulatedMs / 60000).toFixed(1));

  return {
    planned,
    deferred,
    total_estimated_minutes: totalEstimatedMinutes,
    session_tip:  prioritized._tip  || '',
    warnings:     prioritized._warnings || [],
  };
}

/**
 * Asks the LLM to return cards in priority order + tip + warnings.
 * No arithmetic — purely ordering logic.
 */
async function getPrioritizedOrder({ availableMinutes, energyLevel, cards, microCards, subjectConfigs, msPerCard }) {
  const userContent = buildUserMessage({ availableMinutes, energyLevel, cards, microCards, subjectConfigs, msPerCard });

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 1200,
    temperature: 0,
    system: `Sos un tutor que organiza sesiones de estudio. Tu única tarea es ORDENAR las tarjetas por prioridad — no calculés cuántas entran ni tiempos, eso lo hace el sistema.

Criterios de orden (de mayor a menor prioridad):
1. Micro-tarjetas vencidas (remediales — siempre primero).
2. Tarjetas con examen en ≤ 7 días, ordenadas por urgencia.
3. Tarjetas con active_micro_count > 0 (tienen conceptos pendientes).
4. Resto por fecha de vencimiento (más atrasadas primero).

Si energyLevel='tired': preferí tarjetas con higher pass_count (más familiares) sobre tarjetas nuevas.
Si energyLevel='focused': podés incluir tarjetas más desafiantes primero.

Respondé ÚNICAMENTE con JSON válido:
{
  "priority_order": [
    { "type": "micro"|"card", "id": <number>, "reason": "<frase corta>" },
    ...
  ],
  "session_tip": "<consejo corto según estado de ánimo, máx 15 palabras>",
  "warnings": ["<advertencia si hay examen muy próximo>"]
}`,
    messages: [{ role: 'user', content: userContent }],
  });

  const text     = response.content.find((b) => b.type === 'text')?.text ?? '';
  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_e) {
    // Fallback: micro-cards first, then cards by date — LLM failed gracefully
    parsed = { priority_order: buildFallbackOrder({ cards, microCards }), session_tip: '', warnings: [] };
  }

  const order = Array.isArray(parsed.priority_order) ? parsed.priority_order : buildFallbackOrder({ cards, microCards });
  order._tip      = parsed.session_tip || '';
  order._warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  return order;
}

function buildFallbackOrder({ cards, microCards }) {
  const order = [];
  for (const m of microCards) order.push({ type: 'micro', id: m.id, reason: 'vencida' });
  for (const c of cards)      order.push({ type: 'card',  id: c.id, reason: 'vencida' });
  return order;
}

function buildItemMap(cards, microCards) {
  const map = new Map();
  for (const c of cards)  map.set(`card:${c.id}`,  c);
  for (const m of microCards) map.set(`micro:${m.id}`, m);
  return map;
}

function buildUserMessage({ availableMinutes, energyLevel, cards, microCards, subjectConfigs, msPerCard }) {
  const now = new Date();
  const configBySubject = {};
  for (const cfg of subjectConfigs) configBySubject[cfg.subject] = cfg;

  function examInfo(subject) {
    const cfg = configBySubject[subject];
    if (!cfg?.exam_date) return null;
    const days = Math.ceil((new Date(cfg.exam_date) - now) / 86400000);
    return {
      days_until_exam: days,
      exam_label: cfg.label || cfg.exam_type || 'examen',
      scope_pct: cfg.scope_pct ?? 50,
    };
  }

  const microSummary = microCards.map((m) => ({
    id: m.id, type: 'micro',
    concept: m.concept,
    parent_subject: m.parent_subject,
    ...examInfo(m.parent_subject),
  }));

  const cardSummary = cards.map((c) => ({
    id: c.id, type: 'card',
    subject: c.subject,
    pass_count: c.pass_count,
    review_count: c.review_count,
    active_micro_count: parseInt(c.active_micro_count) || 0,
    ...examInfo(c.subject),
  }));

  return `Ordenar por prioridad para una sesión de estudio:

available_minutes: ${availableMinutes}
energy_level: ${energyLevel}
estimated_ms_per_card: ${msPerCard} (ya calculado por el sistema, no lo uses para contar)

Nota: cada tarjeta puede tener "exam_label" (nombre del próximo parcial/final),
"days_until_exam" (días hasta ese examen) y "scope_pct" (% del temario que cubre ese examen).
Usá esta info para priorizar: si hay un parcial en ≤7 días con scope_pct alto, las tarjetas
de esa materia tienen más urgencia.

micro_cards vencidas (${microSummary.length}):
${JSON.stringify(microSummary, null, 2)}

cards vencidas (${cardSummary.length}):
${JSON.stringify(cardSummary, null, 2)}

Devolvé únicamente el JSON con priority_order, session_tip y warnings.`;
}
