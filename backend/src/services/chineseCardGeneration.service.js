import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.CHINESE_CARD_TIMEOUT_MS || 60_000),
    });
  }
  return _anthropic;
}

const HAIKU_MODEL = process.env.CHINESE_CARD_MODEL || 'claude-haiku-4-5-20251001';

// ==================== generateChineseCardDraftForCluster ====================
// Builds sentence-translation cards (Front: Spanish, Back: Chinese hanzi).
// Primary source: example sentences already in the class notes.
// If examples are insufficient, Haiku generates additional variants.

export async function generateChineseCardDraftForCluster(clusterId, options = {}) {
  const userId = options.userId ?? null;

  // Fetch cluster + document
  const { rows: clusterRows } = await dbPool.query(
    `SELECT cl.id, cl.name, cl.definition, cl.document_id, d.subject
     FROM clusters cl
     JOIN documents d ON d.id = cl.document_id
     WHERE cl.id = $1`,
    [clusterId]
  );
  if (!clusterRows.length) {
    const err = new Error('Cluster not found.');
    err.statusCode = 404;
    throw err;
  }
  const cluster = clusterRows[0];

  // Guard: no existing draft
  const { rows: existing } = await dbPool.query(
    `SELECT id FROM cards WHERE cluster_id = $1 AND status = 'draft' LIMIT 1`,
    [clusterId]
  );
  if (existing.length > 0) {
    const err = new Error('Card draft already exists for this cluster.');
    err.statusCode = 409;
    err.code = 'draft_exists';
    err.existingCardId = existing[0].id;
    throw err;
  }

  // Fetch concept (Chinese clusters are 1:1)
  const { rows: concepts } = await dbPool.query(
    `SELECT id, label, definition, source_chunk
     FROM concepts WHERE cluster_id = $1 LIMIT 1`,
    [clusterId]
  );
  if (!concepts.length) {
    const err = new Error('Cluster has no concepts.');
    err.statusCode = 400;
    throw err;
  }

  const concept = concepts[0];

  // Parse the vocab entry stored as JSON in source_chunk
  let entry = {};
  try { entry = JSON.parse(concept.source_chunk || '{}'); } catch { /* use empty */ }

  const hanzi    = entry.hanzi   || null;
  const pinyin   = entry.pinyin  || null;
  const meanings = (entry.meanings || []).join(' / ');
  const allExamples = entry.examples || [];

  // Split examples into translated (usable) and untranslated (need LLM)
  const translated   = allExamples.filter(ex => ex.hanzi && ex.es);
  const untranslated = allExamples.filter(ex => ex.hanzi && !ex.es);

  const maxVariants = Math.min(options.max_variants ?? 5, 8);

  // Base variants come directly from the class notes — highest fidelity
  const baseVariants = translated.map(ex => ({
    question:        ex.es,
    expected_answer: ex.hanzi,
  }));

  // Ask Haiku to: (a) translate untranslated examples, (b) generate extra variants if needed
  let llmVariants = [];
  const wordLabel = hanzi ? `${hanzi} (${pinyin})` : pinyin;

  if ((untranslated.length > 0 || baseVariants.length < maxVariants) && wordLabel) {
    const needExtra = Math.max(0, maxVariants - baseVariants.length - untranslated.length);

    const untranslatedBlock = untranslated.length > 0
      ? `\nOraciones del material SIN traducción (traducí estas al español):\n${untranslated.map(u => `- ${u.hanzi}`).join('\n')}`
      : '';

    const extraBlock = needExtra > 0
      ? `\nAdemás, generá ${needExtra} oraciones NUEVAS en chino (con traducción al español) usando esta misma palabra. Vocabulario simple, máximo 8 caracteres por oración.`
      : '';

    if (untranslatedBlock || extraBlock) {
      try {
        const anthropic = getAnthropicClient();
        const msg = await anthropic.messages.create({
          model: HAIKU_MODEL,
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `Palabra china: ${wordLabel} – ${meanings}
${untranslatedBlock}${extraBlock}

Devolvé SOLO un array JSON con objetos {"hanzi":"...","es":"..."}. Sin markdown.`,
          }],
        });

        const raw = msg.content?.[0]?.text?.trim() || '';
        const s = raw.indexOf('['), e = raw.lastIndexOf(']');
        if (s !== -1 && e !== -1) {
          const parsed = JSON.parse(raw.slice(s, e + 1));
          llmVariants = parsed
            .filter(v => v.hanzi && v.es)
            .map(v => ({ question: v.es, expected_answer: v.hanzi }));
        }
      } catch (err) {
        logger.warn('[chineseCardGen] LLM variant step failed', { clusterId, error: err.message });
      }
    }
  }

  const allVariants = [...baseVariants, ...llmVariants].slice(0, maxVariants);

  if (allVariants.length === 0) {
    const err = new Error('No translated examples available for card generation. Add Spanish translations to the class notes and retry.');
    err.statusCode = 422;
    throw err;
  }

  // Persist card + variants as draft (transactional)
  const title = hanzi
    ? `${hanzi} (${pinyin || '?'}) – ${meanings}`
    : `(${pinyin}) – ${meanings}`;

  const [primary, ...extras] = allVariants;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const cardInsert = await client.query(
      `INSERT INTO cards
         (user_id, subject, prompt_text, expected_answer_text,
          cluster_id, document_id, card_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'chinese_sentence', 'draft')
       RETURNING id`,
      [userId, cluster.subject ?? null, primary.question, primary.expected_answer,
       clusterId, cluster.document_id]
    );
    const cardId = cardInsert.rows[0].id;

    const insertedVariants = [{
      id: null,
      question: primary.question,
      expected_answer: primary.expected_answer,
    }];

    for (const v of extras) {
      const vRow = await client.query(
        `INSERT INTO card_variants
           (card_id, prompt_text, expected_answer_text, user_id, status)
         VALUES ($1, $2, $3, $4, 'draft')
         RETURNING id`,
        [cardId, v.question, v.expected_answer, userId]
      );
      insertedVariants.push({
        id: vRow.rows[0].id,
        question: v.question,
        expected_answer: v.expected_answer,
      });
    }

    await client.query('COMMIT');

    logger.info('[chineseCardGen] Draft created', {
      clusterId, cardId, variantCount: insertedVariants.length,
    });

    return {
      status: 'draft_created',
      cluster_id: clusterId,
      card_group: {
        id: cardId,
        title,
        card_type: 'chinese_sentence',
        status: 'draft',
        subject: cluster.subject,
      },
      variants: insertedVariants,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
