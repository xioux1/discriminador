import Anthropic from '@anthropic-ai/sdk';

const LLM_MODEL = 'claude-sonnet-4-6';
const DEFAULT_RESPONSE_TIME_MS = 45000;

const ENERGY = {
  tired:   { speedMultiplier: 1.4,  budgetMultiplier: 0.75 },
  normal:  { speedMultiplier: 1.0,  budgetMultiplier: 1.0  },
  focused: { speedMultiplier: 0.85, budgetMultiplier: 1.1  },
};

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Plans an optimal study session using an LLM agent.
 *
 * Architecture:
 * - LLM handles prioritization and produces explicit reasoning (agent_log).
 * - JS handles all time-budget arithmetic deterministically.
 * - Cards whose estimated retention is below the subject floor are "forced"
 *   and always included before purely priority-based cards.
 */
export async function planSession({
  availableMinutes,
  energyLevel,
  cards,
  microCards,
  subjectConfigs,
  retentionFloors = {},
  avgResponseTimeMs,
  subjectAvgMsBySubject = {},
  calibrationFactor = 1.0
}) {
  const energy  = ENERGY[energyLevel] ?? ENERGY.normal;
  const baseMs  = (avgResponseTimeMs ?? DEFAULT_RESPONSE_TIME_MS) * calibrationFactor;
  const msPerCard = Math.round(baseMs * energy.speedMultiplier);
  const budgetMs  = availableMinutes * 60 * 1000 * energy.budgetMultiplier;

  const prioritized = await getPrioritizedOrder({
    availableMinutes,
    energyLevel,
    cards,
    microCards,
    subjectConfigs,
    retentionFloors,
    msPerCard,
  });

  const allItems = buildItemMap(cards, microCards);
  const planned  = [];
  const deferred = [];
  let accumulatedMs = 0;
  const seen = new Set();

  for (const ref of prioritized) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = allItems.get(key);
    if (!item) continue;

    const estimatedMs = estimateItemMs({
      item,
      type: ref.type,
      defaultMs: baseMs,
      speedMultiplier: energy.speedMultiplier,
      subjectAvgMsBySubject,
    });

    if (accumulatedMs + estimatedMs <= budgetMs) {
      accumulatedMs += estimatedMs;
      planned.push({
        type:         ref.type,
        id:           ref.id,
        subject:      item.subject || item.parent_subject,
        estimated_ms: estimatedMs,
        reason:       ref.reason || '',
        forced:       ref.forced || false,
      });
    } else {
      const deferDays = (!ref.forced && prioritized._deferDays?.[key]) || 0;
      deferred.push({
        type:       ref.type,
        id:         ref.id,
        subject:    item.subject || item.parent_subject,
        reason:     ref.reason || '',
        forced:     ref.forced || false,
        defer_days: deferDays,
      });
    }
  }

  const totalEstimatedMinutes = parseFloat((accumulatedMs / 60000).toFixed(1));

  // Build card_decisions for the log (all items, planned + deferred)
  const cardDecisions = [
    ...planned.map((p) => {
      const item = allItems.get(`${p.type}:${p.id}`);
      return {
        type:       p.type,
        id:         p.id,
        subject:    p.subject,
        retention:  item?.estimated_retention != null ? Math.round(item.estimated_retention * 100) / 100 : null,
        forced:     p.forced,
        decision:   'planned',
        reason:     p.reason,
      };
    }),
    ...deferred.map((d) => {
      const item = allItems.get(`${d.type}:${d.id}`);
      return {
        type:       d.type,
        id:         d.id,
        subject:    d.subject,
        retention:  item?.estimated_retention != null ? Math.round(item.estimated_retention * 100) / 100 : null,
        forced:     d.forced,
        decision:   d.defer_days > 0 ? 'rescheduled' : 'deferred',
        defer_days: d.defer_days || 0,
        reason:     d.reason,
      };
    }),
  ];

  return {
    planned,
    deferred,
    total_estimated_minutes: totalEstimatedMinutes,
    session_tip:    prioritized._tip      || '',
    warnings:       prioritized._warnings || [],
    agent_log:      prioritized._agentLog || '',
    card_decisions: cardDecisions,
  };
}

async function getPrioritizedOrder({ availableMinutes, energyLevel, cards, microCards, subjectConfigs, retentionFloors, msPerCard }) {
  const userContent = buildUserMessage({ availableMinutes, energyLevel, cards, microCards, subjectConfigs, retentionFloors, msPerCard });

  const response = await getClient().messages.create({
    model: LLM_MODEL,
    max_tokens: 2000,
    temperature: 0,
    system: `Sos un agente de planificación de estudio. Tu tarea es ordenar tarjetas de revisión por prioridad y explicar tu razonamiento.

REGLAS DE PRIORIDAD:
1. Tarjetas "forced=true" (retención estimada bajo el piso configurado) van SIEMPRE primero — el usuario no puede permitirse olvidarlas.
2. Entre tarjetas forced: priorizá por retención más baja primero (más urgente de recuperar).
3. Entre tarjetas no-forced: priorizá por urgencia del examen (días_hasta_examen × peso_materia).
4. Las tarjetas principales van SIEMPRE antes que sus micro-tarjetas dependientes — si se responde bien, las micros se archivan automáticamente.
5. Entre tarjetas principales: si una tiene micros dependientes (parent_also_due=true en las micros), priorizala dentro del grupo de tarjetas principales para que sus micros se archiven cuanto antes.
6. Con energy_level='tired': preferí tarjetas con más pass_count (más familiares).
7. Con energy_level='focused': podés poner tarjetas más difíciles primero.
8. REPROGRAMACIÓN: Para tarjetas no-forced con max_defer_days>0 que no entren en el presupuesto, podés incluir "defer_days": N (1 a max_defer_days) para posponer explícitamente su próxima revisión. Usá defer_days bajos (1-3) si el examen está cerca (<30 días). Podés usar valores mayores si el examen está lejos (>60 días) y la retención es alta. Para tarjetas que querés ver mañana igual, usá defer_days: 0.

Respondé ÚNICAMENTE con JSON válido:
{
  "priority_order": [
    { "type": "micro"|"card", "id": <number>, "reason": "<frase corta>", "forced": true|false, "defer_days": 0 },
    ...
  ],
  "session_tip": "<consejo corto según estado de ánimo y situación, máx 20 palabras>",
  "warnings": ["<advertencia si hay examen muy próximo o retención crítica>"],
  "agent_log": "<razonamiento del agente: 3-6 oraciones explicando decisiones clave — qué forzó, qué difirió, cuántos días reprogramó y por qué>"
}`,
    messages: [{ role: 'user', content: userContent }],
  });

  const text     = response.content.find((b) => b.type === 'text')?.text ?? '';
  const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = {
      priority_order: buildFallbackOrder({ cards, microCards }),
      session_tip: '',
      warnings: [],
      agent_log: 'No se pudo obtener razonamiento del agente (respuesta inválida).'
    };
  }

  const order = Array.isArray(parsed.priority_order)
    ? parsed.priority_order
    : buildFallbackOrder({ cards, microCards });

  // Index defer_days by type:id for O(1) lookup in planSession
  order._deferDays = {};
  for (const item of order) {
    if (item.defer_days > 0) order._deferDays[`${item.type}:${item.id}`] = item.defer_days;
  }
  order._tip      = parsed.session_tip || '';
  order._warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  order._agentLog = parsed.agent_log   || '';
  return order;
}

function dateStr(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  return new Date(val).toISOString().slice(0, 10);
}

function buildFallbackOrder({ cards, microCards }) {
  const todayStr   = new Date().toISOString().slice(0, 10);
  const dueCardIds = new Set(cards.map((c) => c.id));

  const remedialMicros   = microCards.filter((m) => dateStr(m.created_at) === todayStr);
  const dependentMicros  = microCards.filter((m) => dateStr(m.created_at) !== todayStr &&  dueCardIds.has(m.parent_card_id));
  const standaloneMicros = microCards.filter((m) => dateStr(m.created_at) !== todayStr && !dueCardIds.has(m.parent_card_id));

  const parentIds      = new Set(dependentMicros.map((m) => m.parent_card_id));
  const parentsFirst   = cards.filter((c) =>  parentIds.has(c.id));
  const remainingCards = cards.filter((c) => !parentIds.has(c.id));

  return [
    ...parentsFirst.map((c)     => ({ type: 'card',  id: c.id, reason: 'general-primero', forced: c.retention_forced || false })),
    ...remainingCards.map((c)   => ({ type: 'card',  id: c.id, reason: 'vencida',         forced: c.retention_forced || false })),
    ...remedialMicros.map((m)   => ({ type: 'micro', id: m.id, reason: 'remedial-hoy',    forced: m.retention_forced || false })),
    ...dependentMicros.map((m)  => ({ type: 'micro', id: m.id, reason: 'dependiente',     forced: m.retention_forced || false })),
    ...standaloneMicros.map((m) => ({ type: 'micro', id: m.id, reason: 'vencida',         forced: m.retention_forced || false })),
  ];
}

function buildItemMap(cards, microCards) {
  const map = new Map();
  for (const c of cards)      map.set(`card:${c.id}`,  c);
  for (const m of microCards) map.set(`micro:${m.id}`, m);
  return map;
}

function buildUserMessage({ availableMinutes, energyLevel, cards, microCards, subjectConfigs, retentionFloors, msPerCard }) {
  const now = new Date();
  const configBySubject = {};
  for (const cfg of subjectConfigs) configBySubject[cfg.subject] = cfg;

  function examInfo(subject) {
    const cfg = configBySubject[subject];
    if (!cfg?.exam_date) return null;
    const days = Math.ceil((new Date(cfg.exam_date) - now) / 86400000);
    return {
      days_until_exam: days,
      exam_label:      cfg.label || cfg.exam_type || 'examen',
      scope_pct:       cfg.scope_pct ?? 50,
    };
  }

  function retPct(r) {
    return r != null ? `${Math.round(r * 100)}%` : 'nueva';
  }

  const todayStr       = now.toISOString().slice(0, 10);
  const dueCardIds     = new Set(cards.map((c) => c.id));
  const microParentIds = new Set(microCards.map((m) => m.parent_card_id));

  const microSummary = microCards.map((m) => ({
    id:              m.id,
    type:            'micro',
    concept:         m.concept,
    parent_subject:  m.parent_subject,
    parent_card_id:  m.parent_card_id,
    created_today:   dateStr(m.created_at) === todayStr,
    parent_also_due: dueCardIds.has(m.parent_card_id),
    estimated_retention: retPct(m.estimated_retention),
    forced:          m.retention_forced || false,
    retention_floor: `${Math.round((retentionFloors[m.parent_subject] ?? 0.75) * 100)}%`,
    max_defer_days:  m.max_defer_days ?? 0,
    ...examInfo(m.parent_subject),
  }));

  const cardSummary = cards.map((c) => ({
    id:              c.id,
    type:            'card',
    subject:         c.subject,
    pass_count:      c.pass_count,
    review_count:    c.review_count,
    active_micro_count: parseInt(c.active_micro_count) || 0,
    has_micro_in_queue: microParentIds.has(c.id),
    estimated_retention: retPct(c.estimated_retention),
    forced:          c.retention_forced || false,
    retention_floor: `${Math.round((retentionFloors[c.subject] ?? 0.75) * 100)}%`,
    max_defer_days:  c.max_defer_days ?? 0,
    ...examInfo(c.subject),
  }));

  return `Planificar sesión de estudio con las siguientes tarjetas vencidas:

available_minutes: ${availableMinutes}
energy_level: ${energyLevel}
estimated_ms_per_card: ${msPerCard}

Campos clave por tarjeta:
- forced=true → retención estimada por debajo del piso configurado → SIEMPRE incluir
- estimated_retention → porcentaje de retención actual estimado (ej: "72%")
- retention_floor → piso configurado para la materia (ej: "75%")
- days_until_exam → días hasta el próximo examen de esa materia

micro_cards vencidas (${microSummary.length}):
${JSON.stringify(microSummary, null, 2)}

cards vencidas (${cardSummary.length}):
${JSON.stringify(cardSummary, null, 2)}

Devolvé únicamente el JSON con priority_order, session_tip, warnings y agent_log.`;
}

function estimateItemMs({ item, type, defaultMs, speedMultiplier, subjectAvgMsBySubject }) {
  const subject    = type === 'micro' ? item.parent_subject : item.subject;
  const subjectAvg = subject ? subjectAvgMsBySubject[subject] : null;
  const explicitAvg = type === 'micro'
    ? item.parent_avg_response_time_ms
    : item.avg_response_time_ms;

  const referenceMs = Number(explicitAvg) > 0
    ? Number(explicitAvg)
    : (Number(subjectAvg) > 0 ? Number(subjectAvg) : defaultMs);

  return Math.round(referenceMs * speedMultiplier);
}

function normalizeSessionText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function findDuplicatedSessionItems(cards = [], microCards = []) {
  const seenByText      = new Map();
  const duplicatesByText = new Map();

  const register = ({ id, type, text }) => {
    const normalized = normalizeSessionText(text);
    if (!normalized) return;
    const current  = { id, type, text: String(text).trim() };
    const existing = seenByText.get(normalized);
    if (!existing) { seenByText.set(normalized, [current]); return; }
    existing.push(current);
    duplicatesByText.set(normalized, existing);
  };

  for (const card  of cards)      register({ id: card.id,  type: 'card',  text: card.prompt_text });
  for (const micro of microCards) register({ id: micro.id, type: 'micro', text: micro.question   });

  return Array.from(duplicatesByText.values());
}
