import { Router } from 'express';
import { dbPool } from '../db/client.js';
import Anthropic from '@anthropic-ai/sdk';

const cardsRouter = Router();

function normalizeReason(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBatchAction(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

cardsRouter.get('/cards/browser', async (req, res) => {
  const userId = req.user.id;
  const { rows } = await dbPool.query(
    `SELECT
       c.id,
       c.subject,
       c.prompt_text,
       c.expected_answer_text,
       c.next_review_at,
       c.last_reviewed_at,
       c.created_at,
       c.review_count,
       c.pass_count,
       c.interval_days,
       c.ease_factor,
       c.flagged,
       c.notes,
       c.suspended_at,
       COUNT(mc.id) FILTER (WHERE mc.status = 'active')  AS active_micro_count,
       COUNT(cv.id)                                       AS variant_count
     FROM cards c
     LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id AND mc.user_id = c.user_id
     LEFT JOIN card_variants cv ON cv.card_id = c.id
     WHERE c.user_id = $1
       AND c.archived_at IS NULL
     GROUP BY c.id
     ORDER BY c.next_review_at ASC, c.id ASC`,
    [userId]
  );
  return res.json({ cards: rows });
});

// GET /cards/:id — fetch a single card with stats
cardsRouter.get('/cards/:id', async (req, res) => {
  const userId = req.user.id;
  const cardId = parseInt(req.params.id, 10);
  if (!Number.isFinite(cardId)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rows } = await dbPool.query(
      `SELECT
         c.id, c.subject, c.prompt_text, c.expected_answer_text,
         c.next_review_at, c.last_reviewed_at, c.created_at,
         c.review_count, c.pass_count, c.interval_days, c.ease_factor,
         c.flagged, c.notes, c.suspended_at,
         COUNT(mc.id) FILTER (WHERE mc.status = 'active') AS active_micro_count,
         COUNT(cv.id) AS variant_count
       FROM cards c
       LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id AND mc.user_id = c.user_id
       LEFT JOIN card_variants cv ON cv.card_id = c.id
       WHERE c.id = $1 AND c.user_id = $2 AND c.archived_at IS NULL
       GROUP BY c.id`,
      [cardId, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.json({ card: rows[0] });
  } catch (err) {
    console.error('GET /cards/:id', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PATCH /cards/:id/flag  — mark a card as flagged with optional note
cardsRouter.patch('/cards/:id/flag', async (req, res) => {
  const userId = req.user.id;
  const cardId = parseInt(req.params.id, 10);
  if (!Number.isFinite(cardId)) return res.status(400).json({ error: 'invalid_id' });

  const notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 500) : null;

  const { rowCount } = await dbPool.query(
    `UPDATE cards SET flagged = TRUE, notes = COALESCE($1, notes), updated_at = now()
     WHERE id = $2 AND user_id = $3`,
    [notes, cardId, userId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
  return res.json({ flagged: true });
});

// PATCH /micro-cards/:id/flag  — same for micro-cards
cardsRouter.patch('/micro-cards/:id/flag', async (req, res) => {
  const userId = req.user.id;
  const microId = parseInt(req.params.id, 10);
  if (!Number.isFinite(microId)) return res.status(400).json({ error: 'invalid_id' });

  const notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 500) : null;

  const { rowCount } = await dbPool.query(
    `UPDATE micro_cards SET flagged = TRUE, notes = COALESCE($1, notes), updated_at = now()
     WHERE id = $2 AND user_id = $3`,
    [notes, microId, userId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
  return res.json({ flagged: true });
});

// PATCH /cards/:id/archive  — archive card with mandatory reason
cardsRouter.patch('/cards/:id/archive', async (req, res) => {
  const userId = req.user.id;
  const cardId = parseInt(req.params.id, 10);
  if (!Number.isFinite(cardId)) return res.status(400).json({ error: 'invalid_id' });

  const reason = normalizeReason(req.body?.reason);
  if (reason.length < 5) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'reason must contain at least 5 characters.'
    });
  }

  // Check if card exists and belongs to user first
  const { rows: check } = await dbPool.query(
    'SELECT id, archived_at FROM cards WHERE id = $1 AND user_id = $2',
    [cardId, userId]
  );
  if (!check.length) return res.status(404).json({ error: 'not_found', message: 'Tarjeta no encontrada.' });
  if (check[0].archived_at) return res.json({ archived: true }); // already archived — idempotent

  await dbPool.query(
    `UPDATE cards SET archived_at = now(), archived_reason = $1, updated_at = now()
     WHERE id = $2 AND user_id = $3`,
    [reason.slice(0, 500), cardId, userId]
  );
  return res.json({ archived: true });
});

// PATCH /micro-cards/:id/archive  — archive micro-card with mandatory reason
cardsRouter.patch('/micro-cards/:id/archive', async (req, res) => {
  const userId = req.user.id;
  const microId = parseInt(req.params.id, 10);
  if (!Number.isFinite(microId)) return res.status(400).json({ error: 'invalid_id' });

  const reason = normalizeReason(req.body?.reason);
  if (reason.length < 5) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'reason must contain at least 5 characters.'
    });
  }

  const { rows: check } = await dbPool.query(
    'SELECT id, status FROM micro_cards WHERE id = $1 AND user_id = $2',
    [microId, userId]
  );
  if (!check.length) return res.status(404).json({ error: 'not_found', message: 'Micro-tarjeta no encontrada.' });
  if (check[0].status === 'archived') return res.json({ archived: true });

  await dbPool.query(
    `UPDATE micro_cards
     SET status = 'archived',
         notes = CASE
           WHEN notes IS NULL OR trim(notes) = '' THEN $1
           ELSE notes || E'\n[archived] ' || $1
         END,
         updated_at = now()
     WHERE id = $2 AND user_id = $3`,
    [reason.slice(0, 500), microId, userId]
  );

  return res.json({ archived: true });
});

// PATCH /micro-cards/:id/question  — update the question text of a micro-card
cardsRouter.patch('/micro-cards/:id/question', async (req, res) => {
  const userId  = req.user.id;
  const microId = parseInt(req.params.id, 10);
  if (!Number.isFinite(microId)) return res.status(400).json({ error: 'invalid_id' });

  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (question.length < 5) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'question must contain at least 5 characters.'
    });
  }

  const { rowCount } = await dbPool.query(
    `UPDATE micro_cards SET question = $1, updated_at = now()
     WHERE id = $2 AND user_id = $3 AND status = 'active'`,
    [question, microId, userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'not_found', message: 'Micro-tarjeta no encontrada o archivada.' });

  return res.json({ updated: true });
});

// POST /cards/batch  — bulk actions in browser tab
cardsRouter.post('/cards/batch', async (req, res) => {
  const userId = req.user.id;
  const action = normalizeBatchAction(req.body?.action);
  const idsRaw = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = [...new Set(idsRaw.map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id)))];
  if (!ids.length) {
    return res.status(422).json({ error: 'validation_error', message: 'ids is required.' });
  }

  if (action === 'archive') {
    const reason = normalizeReason(req.body?.reason);
    if (reason.length < 5) {
      return res.status(422).json({ error: 'validation_error', message: 'reason must contain at least 5 characters.' });
    }
    const { rowCount } = await dbPool.query(
      `UPDATE cards
       SET archived_at = now(),
           archived_reason = $1,
           updated_at = now()
       WHERE user_id = $2
         AND id = ANY($3::int[])
         AND archived_at IS NULL`,
      [reason.slice(0, 500), userId, ids]
    );
    return res.json({ updated: rowCount });
  }

  if (action === 'suspend') {
    const { rowCount } = await dbPool.query(
      `UPDATE cards
       SET suspended_at = now(),
           updated_at = now()
       WHERE user_id = $1
         AND id = ANY($2::int[])
         AND archived_at IS NULL`,
      [userId, ids]
    );
    return res.json({ updated: rowCount });
  }

  if (action === 'reactivate') {
    const { rowCount } = await dbPool.query(
      `UPDATE cards
       SET suspended_at = NULL,
           updated_at = now()
       WHERE user_id = $1
         AND id = ANY($2::int[])
         AND archived_at IS NULL`,
      [userId, ids]
    );
    return res.json({ updated: rowCount });
  }

  if (action === 'edit') {
    const nextSubject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const nextPrompt = typeof req.body?.prompt_text === 'string' ? req.body.prompt_text.trim() : '';
    const nextAnswer = typeof req.body?.expected_answer_text === 'string' ? req.body.expected_answer_text.trim() : '';
    if (!nextSubject && !nextPrompt && !nextAnswer) {
      return res.status(422).json({
        error: 'validation_error',
        message: 'subject, prompt_text, or expected_answer_text is required for edit.'
      });
    }
    const { rowCount } = await dbPool.query(
      `UPDATE cards
       SET subject = CASE WHEN $1 = '' THEN subject ELSE $1 END,
           prompt_text = CASE WHEN $2 = '' THEN prompt_text ELSE $2 END,
           expected_answer_text = CASE WHEN $3 = '' THEN expected_answer_text ELSE $3 END,
           updated_at = now()
       WHERE user_id = $4
         AND id = ANY($5::int[])
         AND archived_at IS NULL`,
      [nextSubject, nextPrompt, nextAnswer, userId, ids]
    );
    return res.json({ updated: rowCount });
  }

  return res.status(422).json({ error: 'validation_error', message: 'Unsupported action.' });
});

// POST /cards/:id/ai-fix-answer — use Claude Sonnet to correct expected_answer_text based on violated SQL rules
cardsRouter.post('/cards/:id/ai-fix-answer', async (req, res) => {
  const userId = req.user.id;
  const cardId = parseInt(req.params.id, 10);
  if (!Number.isFinite(cardId)) return res.status(400).json({ error: 'invalid_id' });

  try {
    const [cardResult, violationsResult] = await Promise.all([
      dbPool.query(
        `SELECT c.id, c.subject, c.prompt_text, c.expected_answer_text,
                s.rules AS standard_rules
         FROM cards c
         LEFT JOIN sql_coding_standards s ON s.subject = c.subject AND s.user_id = c.user_id
         WHERE c.id = $1 AND c.user_id = $2`,
        [cardId, userId]
      ),
      dbPool.query(
        `SELECT r.violations FROM sql_standard_validation_results r
         JOIN sql_coding_standards s ON r.standard_id = s.id
         WHERE r.card_id = $1 AND r.user_id = $2 AND NOT r.compliant
         ORDER BY r.validated_at DESC LIMIT 1`,
        [cardId, userId]
      ),
    ]);

    if (!cardResult.rows.length) return res.status(404).json({ error: 'not_found' });
    const card = cardResult.rows[0];
    const rules = card.standard_rules || [];
    const violations = violationsResult.rows[0]?.violations || [];

    if (!rules.length && !violations.length) {
      return res.status(422).json({ error: 'no_rules', message: 'No hay reglas ni violaciones registradas para esta tarjeta.' });
    }

    const rulesText = rules.map(r =>
      `- [${r.severity}] (${r.category}): ${r.description}${r.pattern_hint ? ` | Ej: ${r.pattern_hint}` : ''}`
    ).join('\n');
    const violationsText = violations.map(v =>
      `- ${v.description}${v.quote ? `\n  Fragmento incorrecto: "${v.quote}"` : ''}`
    ).join('\n');

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 0,
      system: `Sos un experto en SQL/PL-SQL y corrector de soluciones modelo para tarjetas de estudio universitario.
Tu tarea: reescribir la "respuesta esperada" (solución modelo) para que cumpla con las reglas de estilo de la cátedra.

REGLAS:
- Mantené la lógica del código intacta. No cambies lo que hace, solo el estilo
- Aplicá únicamente las correcciones necesarias para cumplir las reglas violadas
- Respondé SOLO con el código corregido, sin texto antes ni después, sin bloques de markdown`,
      messages: [{
        role: 'user',
        content: `CONSIGNA: ${card.prompt_text}

REGLAS DE LA CÁTEDRA:
${rulesText || '(sin reglas registradas)'}

VIOLACIONES EN LA RESPUESTA ACTUAL:
${violationsText || '(aplicá las reglas generales de la cátedra)'}

RESPUESTA ESPERADA A CORREGIR:
${card.expected_answer_text}`,
      }],
    });

    const suggestedAnswer = response.content.find(b => b.type === 'text')?.text?.trim() ?? '';
    if (!suggestedAnswer) return res.status(500).json({ error: 'empty_response' });

    return res.json({ suggested_answer: suggestedAnswer });
  } catch (err) {
    console.error('POST /cards/:id/ai-fix-answer', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /cards/rename-subject — rename all cards of a subject (merge/deduplicate subjects)
cardsRouter.post('/cards/rename-subject', async (req, res) => {
  const userId = req.user.id;
  const { old_subject, new_subject } = req.body || {};

  if (!old_subject || typeof old_subject !== 'string' || !new_subject || typeof new_subject !== 'string') {
    return res.status(422).json({ error: 'validation_error', message: 'old_subject y new_subject son obligatorios.' });
  }

  try {
    const { rowCount } = await dbPool.query(
      `UPDATE cards SET subject = $1, updated_at = now()
       WHERE user_id = $2 AND subject = $3`,
      [new_subject.trim(), userId, old_subject.trim()]
    );
    return res.json({ updated: rowCount });
  } catch (err) {
    console.error('POST /cards/rename-subject error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /cards/detect-redundant — use LLM to find semantically similar cards that could be merged as variants
cardsRouter.post('/cards/detect-redundant', async (req, res) => {
  const userId = req.user.id;
  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : null;

  try {
    const query = subject
      ? `SELECT id, subject, prompt_text, expected_answer_text FROM cards WHERE user_id = $1 AND archived_at IS NULL AND subject = $2 ORDER BY subject, id`
      : `SELECT id, subject, prompt_text, expected_answer_text FROM cards WHERE user_id = $1 AND archived_at IS NULL ORDER BY subject, id`;
    const params = subject ? [userId, subject] : [userId];
    const { rows: cards } = await dbPool.query(query, params);

    if (cards.length < 2) return res.json({ clusters: [] });

    // Group by subject to keep each LLM call focused
    const bySubject = {};
    for (const card of cards) {
      const key = card.subject || '';
      if (!bySubject[key]) bySubject[key] = [];
      bySubject[key].push(card);
    }

    const allClusters = [];
    const client = new Anthropic();

    for (const [subjectName, subjectCards] of Object.entries(bySubject)) {
      if (subjectCards.length < 2) continue;

      const cardList = subjectCards.map((c) =>
        `[${c.id}] PREGUNTA: ${c.prompt_text.slice(0, 300)}\nRESPUESTA: ${c.expected_answer_text.slice(0, 200)}`
      ).join('\n\n---\n\n');

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        temperature: 0,
        system: `Sos un asistente que detecta tarjetas de estudio redundantes.
Tu tarea: identificar grupos de tarjetas que evalúen EXACTAMENTE el mismo concepto puntual, aunque estén formuladas diferente.

Criterios para considerar tarjetas como redundantes:
- Evalúan el mismo concepto o habilidad específica (no solo el mismo tema general)
- Una tarjeta podría reemplazar a la otra sin perder cobertura
- Preguntan lo mismo pero con diferente redacción, valores o ejemplos

Respondé ÚNICAMENTE con JSON válido, sin texto adicional:
{"clusters": [{"card_ids": [id1, id2], "reason": "explicación breve en español"}]}

Si no hay redundancias, respondé exactamente: {"clusters": []}`,
        messages: [{ role: 'user', content: `Materia: ${subjectName || '(sin materia)'}\n\nTarjetas:\n\n${cardList}` }]
      });

      const text = response.content.find((b) => b.type === 'text')?.text ?? '';
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) { try { parsed = JSON.parse(match[0]); } catch { continue; } }
        else continue;
      }

      if (!Array.isArray(parsed?.clusters)) continue;

      for (const cluster of parsed.clusters) {
        if (!Array.isArray(cluster.card_ids) || cluster.card_ids.length < 2) continue;
        const clusterCards = cluster.card_ids
          .map((id) => subjectCards.find((c) => c.id === id))
          .filter(Boolean);
        if (clusterCards.length < 2) continue;
        allClusters.push({
          cards: clusterCards.map((c) => ({
            id: c.id,
            subject: c.subject,
            prompt_text: c.prompt_text,
            expected_answer_text: c.expected_answer_text
          })),
          reason: cluster.reason || ''
        });
      }
    }

    return res.json({ clusters: allClusters });
  } catch (err) {
    console.error('POST /cards/detect-redundant', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /cards/merge-as-variants — keep one card as primary, convert the rest into its variants and archive them
cardsRouter.post('/cards/merge-as-variants', async (req, res) => {
  const userId = req.user.id;
  const primaryId = parseInt(req.body?.primary_card_id, 10);
  const secondaryIds = Array.isArray(req.body?.secondary_card_ids)
    ? [...new Set(req.body.secondary_card_ids.map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id)))]
    : [];

  if (!Number.isFinite(primaryId) || secondaryIds.length === 0) {
    return res.status(422).json({ error: 'validation_error', message: 'primary_card_id y secondary_card_ids son obligatorios.' });
  }
  if (secondaryIds.includes(primaryId)) {
    return res.status(422).json({ error: 'validation_error', message: 'La tarjeta primaria no puede estar en secondary_card_ids.' });
  }

  try {
    const allIds = [primaryId, ...secondaryIds];
    const { rows: ownedCards } = await dbPool.query(
      `SELECT id, prompt_text, expected_answer_text FROM cards WHERE id = ANY($1::int[]) AND user_id = $2 AND archived_at IS NULL`,
      [allIds, userId]
    );
    const ownedMap = new Map(ownedCards.map((c) => [c.id, c]));

    if (!ownedMap.has(primaryId)) {
      return res.status(404).json({ error: 'not_found', message: 'Tarjeta primaria no encontrada.' });
    }

    let merged = 0;
    for (const secId of secondaryIds) {
      const card = ownedMap.get(secId);
      if (!card) continue;
      await dbPool.query(
        `INSERT INTO card_variants (card_id, prompt_text, expected_answer_text, user_id) VALUES ($1, $2, $3, $4)`,
        [primaryId, card.prompt_text, card.expected_answer_text, userId]
      );
      await dbPool.query(
        `UPDATE cards SET archived_at = now(), archived_reason = $1, updated_at = now() WHERE id = $2 AND user_id = $3`,
        [`Mergeada como variante de #${primaryId}`, secId, userId]
      );
      merged++;
    }

    return res.json({ merged });
  } catch (err) {
    console.error('POST /cards/merge-as-variants', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default cardsRouter;
