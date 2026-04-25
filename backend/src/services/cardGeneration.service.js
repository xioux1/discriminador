import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { chunkText } from './conceptExtractor.service.js';
import { logger } from '../utils/logger.js';

// ==================== Lazy Anthropic client ====================

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.CARD_GEN_LLM_TIMEOUT_MS || 60_000),
    });
  }
  return _anthropic;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_EXCERPT_LENGTH = 1200;
const MAX_SOURCE_EXCERPTS = 8;

// ==================== safeJsonParseObject ====================

export function safeJsonParseObject(raw) {
  if (!raw || typeof raw !== 'string') return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {}

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {}
  }

  return null;
}

// ==================== getDefaultMaxVariantsForCluster ====================

export function getDefaultMaxVariantsForCluster(cluster) {
  const tier = cluster?.relative_priority_tier ?? cluster?.priority_tier ?? null;
  if (tier === 'A') return 5;
  if (tier === 'B') return 3;
  if (tier === 'C') return 2;
  if (tier === 'D') return 1;
  return 5;
}

// ==================== buildClusterCardContext ====================

export async function buildClusterCardContext(clusterId) {
  // Fetch cluster
  const { rows: clusterRows } = await dbPool.query(
    `SELECT id, document_id, name, definition,
            importance_score, relative_importance_score,
            priority_tier, relative_priority_tier
     FROM clusters
     WHERE id = $1`,
    [clusterId]
  );
  if (!clusterRows.length) {
    const err = new Error('Cluster not found.');
    err.statusCode = 404;
    throw err;
  }
  const cluster = clusterRows[0];

  if (!cluster.document_id) {
    const err = new Error('Cluster has no associated document.');
    err.statusCode = 400;
    throw err;
  }

  // Fetch document
  const { rows: docRows } = await dbPool.query(
    `SELECT id, original_filename, subject,
            COALESCE(text, content, transcript) AS body
     FROM documents
     WHERE id = $1`,
    [cluster.document_id]
  );
  if (!docRows.length) {
    const err = new Error('Document not found.');
    err.statusCode = 404;
    throw err;
  }
  const doc = docRows[0];

  // Fetch concepts for this cluster
  const { rows: conceptRows } = await dbPool.query(
    `SELECT id, label, definition, evidence, source_chunk, source_chunk_index
     FROM concepts
     WHERE cluster_id = $1
     ORDER BY source_chunk_index ASC NULLS LAST`,
    [clusterId]
  );
  if (!conceptRows.length) {
    const err = new Error('Cluster has no associated concepts.');
    err.statusCode = 400;
    throw err;
  }

  // Build source excerpts
  const excerptMap = new Map();

  // 1. Use source_chunk directly from concepts when available
  for (const c of conceptRows) {
    if (c.source_chunk_index != null && c.source_chunk && !excerptMap.has(c.source_chunk_index)) {
      const text = c.source_chunk.length > MAX_EXCERPT_LENGTH
        ? c.source_chunk.slice(0, MAX_EXCERPT_LENGTH)
        : c.source_chunk;
      excerptMap.set(c.source_chunk_index, text);
    }
  }

  // 2. For concepts with a chunk_index but no stored source_chunk, reconstruct from document
  const missingIndexes = conceptRows
    .filter(c => c.source_chunk_index != null && !excerptMap.has(c.source_chunk_index))
    .map(c => c.source_chunk_index);

  if (missingIndexes.length > 0 && doc.body) {
    // Try DB-cached chunk embeddings first (chunk_text column)
    const { rows: cachedChunks } = await dbPool.query(
      `SELECT chunk_index, chunk_text
       FROM document_chunk_embeddings
       WHERE document_id = $1
         AND chunk_index = ANY($2::int[])
       ORDER BY chunk_index`,
      [doc.id, missingIndexes]
    );

    for (const row of cachedChunks) {
      if (!excerptMap.has(row.chunk_index) && row.chunk_text) {
        const text = row.chunk_text.length > MAX_EXCERPT_LENGTH
          ? row.chunk_text.slice(0, MAX_EXCERPT_LENGTH)
          : row.chunk_text;
        excerptMap.set(row.chunk_index, text);
      }
    }

    // If still missing, reconstruct by re-chunking the document text
    const stillMissing = missingIndexes.filter(i => !excerptMap.has(i));
    if (stillMissing.length > 0 && doc.body) {
      const chunks = chunkText(doc.body, 300, 50);
      for (const idx of stillMissing) {
        const chunk = chunks.find(ch => ch.index === idx);
        if (chunk) {
          const text = chunk.text.length > MAX_EXCERPT_LENGTH
            ? chunk.text.slice(0, MAX_EXCERPT_LENGTH)
            : chunk.text;
          excerptMap.set(idx, text);
        }
      }
    }
  }

  // Limit to MAX_SOURCE_EXCERPTS, sorted by chunk index
  const sourceExcerpts = Array.from(excerptMap.entries())
    .sort(([a], [b]) => a - b)
    .slice(0, MAX_SOURCE_EXCERPTS)
    .map(([chunk_index, text]) => ({ chunk_index, text }));

  return {
    cluster: {
      id: cluster.id,
      name: cluster.name,
      definition: cluster.definition,
      priority_tier: cluster.priority_tier,
      relative_priority_tier: cluster.relative_priority_tier,
      importance_score: cluster.importance_score,
      relative_importance_score: cluster.relative_importance_score,
    },
    document: {
      id: doc.id,
      title: doc.original_filename,
      subject_name: doc.subject,
    },
    concepts: conceptRows.map(c => ({
      id: c.id,
      label: c.label,
      definition: c.definition,
      evidence: c.evidence ?? null,
      source_chunk: c.source_chunk ?? null,
      source_chunk_index: c.source_chunk_index ?? null,
    })),
    source_excerpts: sourceExcerpts,
  };
}

// ==================== buildCardGenerationPrompt ====================

export function buildCardGenerationPrompt(context, options = {}) {
  const { cluster, concepts, source_excerpts } = context;
  const maxVariants = options.maxVariants ?? 5;

  const clusterJson = JSON.stringify({
    id: cluster.id,
    name: cluster.name,
    definition: cluster.definition,
  }, null, 2);

  const conceptsJson = JSON.stringify(
    concepts.map(c => ({
      id: c.id,
      label: c.label,
      definition: c.definition,
      evidence: c.evidence,
      source_chunk_index: c.source_chunk_index,
    })),
    null,
    2
  );

  const sourceExcerptsJson = JSON.stringify(source_excerpts, null, 2);

  return `Sos un asistente experto en diseño de tarjetas de estudio.

Vas a recibir un cluster de conceptos extraídos de un documento de estudio.
Tu tarea es generar UNA familia de tarjeta y varias variantes de pregunta/respuesta para estudiar ese cluster.

Objetivo:
- La familia de tarjeta representa el cluster.
- Cada variante evalúa un concepto importante o una relación importante entre conceptos del cluster.
- Las respuestas deben basarse únicamente en el material provisto.

Reglas estrictas:
1. Usá sólo el material provisto. No inventes datos externos.
2. Las preguntas deben ser abiertas, no multiple choice, no verdadero/falso.
3. Cada pregunta debe evaluar comprensión, no repetición mecánica.
4. Cada respuesta esperada debe poder decirse oralmente en 40–60 segundos.
5. Cada respuesta esperada debe tener aproximadamente 80–140 palabras.
6. No generes variantes duplicadas.
7. Si varios conceptos se solapan, combinalos en una variante más fuerte.
8. Cada variante debe incluir una rúbrica de corrección con 3 a 6 bullets.
9. La rúbrica debe indicar qué elementos mínimos debe mencionar el estudiante para aprobar.
10. No generes más de ${maxVariants} variantes.
11. Cada variante debe incluir source_concept_ids usando sólo IDs reales provistos.
12. Cada variante debe incluir source_chunk_indexes usando sólo índices reales provistos.
13. Si no hay source_chunk_index disponible para una variante, usar [].
14. No modifiques los UUIDs.
15. Respondé sólo con JSON. Sin markdown, sin backticks, sin texto adicional.

Tipo de card:
theoretical_open

Idioma:
español

Formato exacto de salida:
{
  "card_group": {
    "title": "título breve de la familia de tarjeta",
    "card_type": "theoretical_open"
  },
  "variants": [
    {
      "question": "pregunta abierta",
      "expected_answer": "respuesta esperada",
      "grading_rubric": [
        "criterio 1",
        "criterio 2",
        "criterio 3"
      ],
      "source_concept_ids": ["uuid"],
      "source_chunk_indexes": [1],
      "difficulty": "easy|medium|hard",
      "answer_time_seconds": 50
    }
  ]
}

Datos del cluster:
${clusterJson}

Conceptos:
${conceptsJson}

Fragmentos fuente:
${sourceExcerptsJson}

Recordá:
- Si el material no alcanza para una variante, no la generes.
- Es mejor generar 2 buenas variantes que 5 mediocres.
- La respuesta debe sonar como una respuesta oral clara de estudiante.
- No conviertas cada label automáticamente en una pregunta si hay solapamiento.
- Priorizá preguntas que ayuden a aprobar un examen oral/escrito teórico.`;
}

// ==================== validateGeneratedCardDraft ====================

export function validateGeneratedCardDraft(output, context, maxVariants) {
  const errors = [];

  // Validate card_group
  if (!output.card_group || typeof output.card_group !== 'object') {
    errors.push('card_group missing or not an object');
    return { valid: false, errors, validVariants: [] };
  }

  const { title, card_type } = output.card_group;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    errors.push('card_group.title is empty or missing');
  } else {
    const wordCount = title.trim().split(/\s+/).length;
    if (wordCount < 3 || wordCount > 12) {
      errors.push(`card_group.title has ${wordCount} words (expected 3–12)`);
    }
  }

  if (card_type !== 'theoretical_open') {
    errors.push(`card_group.card_type must be "theoretical_open", got "${card_type}"`);
  }

  if (errors.length > 0) {
    return { valid: false, errors, validVariants: [] };
  }

  // Validate variants
  if (!Array.isArray(output.variants) || output.variants.length === 0) {
    return { valid: false, errors: ['variants must be a non-empty array'], validVariants: [] };
  }

  if (output.variants.length > maxVariants) {
    logger.warn(`[cardGen] LLM returned ${output.variants.length} variants, trimming to ${maxVariants}`);
    output.variants = output.variants.slice(0, maxVariants);
  }

  const validConceptIds = new Set(context.concepts.map(c => c.id));
  const validChunkIndexes = new Set([
    ...context.concepts.map(c => c.source_chunk_index).filter(i => i != null),
    ...context.source_excerpts.map(e => e.chunk_index),
  ]);

  const seenQuestions = new Set();
  const validVariants = [];
  const variantErrors = [];

  for (let i = 0; i < output.variants.length; i++) {
    const v = output.variants[i];
    const vErrs = [];

    if (!v.question || typeof v.question !== 'string' || v.question.trim().length === 0) {
      vErrs.push('question is empty');
    } else {
      const normalized = v.question.trim().toLowerCase();
      if (seenQuestions.has(normalized)) {
        vErrs.push('duplicate question');
      } else {
        seenQuestions.add(normalized);
      }
    }

    if (!v.expected_answer || typeof v.expected_answer !== 'string' || v.expected_answer.trim().length === 0) {
      vErrs.push('expected_answer is empty');
    } else {
      const wordCount = v.expected_answer.trim().split(/\s+/).length;
      if (wordCount < 50 || wordCount > 180) {
        vErrs.push(`expected_answer has ${wordCount} words (expected 50–180)`);
      }
    }

    if (!Array.isArray(v.grading_rubric) || v.grading_rubric.length < 3 || v.grading_rubric.length > 6) {
      vErrs.push(`grading_rubric must have 3–6 items, got ${Array.isArray(v.grading_rubric) ? v.grading_rubric.length : 'non-array'}`);
    } else if (!v.grading_rubric.every(r => typeof r === 'string' && r.trim().length > 0)) {
      vErrs.push('grading_rubric items must be non-empty strings');
    }

    if (!Array.isArray(v.source_concept_ids)) {
      vErrs.push('source_concept_ids must be an array');
    } else {
      const invalid = v.source_concept_ids.filter(id => !validConceptIds.has(id));
      if (invalid.length > 0) {
        vErrs.push(`source_concept_ids contains unknown IDs: ${invalid.join(', ')}`);
      }
    }

    if (!Array.isArray(v.source_chunk_indexes)) {
      vErrs.push('source_chunk_indexes must be an array');
    } else {
      const invalid = v.source_chunk_indexes.filter(idx => !validChunkIndexes.has(idx));
      if (invalid.length > 0) {
        vErrs.push(`source_chunk_indexes contains unknown indexes: ${invalid.join(', ')}`);
      }
    }

    if (!['easy', 'medium', 'hard'].includes(v.difficulty)) {
      vErrs.push(`difficulty must be easy|medium|hard, got "${v.difficulty}"`);
    }

    const ats = Number(v.answer_time_seconds);
    if (!Number.isFinite(ats) || ats < 30 || ats > 90) {
      vErrs.push(`answer_time_seconds must be 30–90, got ${v.answer_time_seconds}`);
    }

    if (vErrs.length > 0) {
      logger.warn(`[cardGen] Variant ${i} discarded:`, vErrs);
      variantErrors.push({ index: i, errors: vErrs });
    } else {
      validVariants.push(v);
    }
  }

  if (validVariants.length === 0) {
    return {
      valid: false,
      errors: ['No valid variants after validation', ...variantErrors.map(e => `v${e.index}: ${e.errors.join('; ')}`)],
      validVariants: [],
    };
  }

  return { valid: true, errors: [], validVariants };
}

// ==================== persistGeneratedCardDraft ====================

export async function persistGeneratedCardDraft(context, validatedOutput, userId) {
  const { cluster, document } = context;
  const { card_group, validVariants } = validatedOutput;

  // The parent card IS a study item: use first variant's Q&A so the scheduler
  // can always evaluate it. Remaining variants go into card_variants for variety.
  const [primaryVariant, ...extraVariants] = validVariants;

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // Insert parent card using first variant's question/answer
    const cardInsert = await client.query(
      `INSERT INTO cards
         (user_id, subject, prompt_text, expected_answer_text,
          cluster_id, document_id, card_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
       RETURNING id`,
      [
        userId ?? null,
        document.subject_name ?? null,
        primaryVariant.question,
        primaryVariant.expected_answer,
        cluster.id,
        document.id,
        'theoretical_open',
      ]
    );
    const cardId = cardInsert.rows[0].id;

    // Insert remaining variants into card_variants
    const insertedVariants = [];

    // Always expose the primary variant in the response (it's the parent card)
    insertedVariants.push({
      id: null,           // lives on the parent card row, not card_variants
      question: primaryVariant.question,
      expected_answer: primaryVariant.expected_answer,
      grading_rubric: primaryVariant.grading_rubric,
      difficulty: primaryVariant.difficulty,
      answer_time_seconds: primaryVariant.answer_time_seconds,
      source_concept_ids: primaryVariant.source_concept_ids,
      source_chunk_indexes: primaryVariant.source_chunk_indexes,
    });

    for (const v of extraVariants) {
      const variantInsert = await client.query(
        `INSERT INTO card_variants
           (card_id, user_id, prompt_text, expected_answer_text,
            source_concept_ids, source_chunk_indexes,
            grading_rubric, difficulty, answer_time_seconds, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, 'draft')
         RETURNING id`,
        [
          cardId,
          userId ?? null,
          v.question,
          v.expected_answer,
          JSON.stringify(v.source_concept_ids ?? []),
          JSON.stringify(v.source_chunk_indexes ?? []),
          JSON.stringify(v.grading_rubric ?? []),
          v.difficulty,
          v.answer_time_seconds,
        ]
      );
      insertedVariants.push({
        id: variantInsert.rows[0].id,
        question: v.question,
        expected_answer: v.expected_answer,
        grading_rubric: v.grading_rubric,
        difficulty: v.difficulty,
        answer_time_seconds: v.answer_time_seconds,
        source_concept_ids: v.source_concept_ids,
        source_chunk_indexes: v.source_chunk_indexes,
      });
    }

    await client.query('COMMIT');

    return {
      card_group: {
        id: cardId,
        title: card_group.title,
        card_type: 'theoretical_open',
        status: 'draft',
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

// ==================== generateCardDraftForCluster ====================

export async function generateCardDraftForCluster(clusterId, options = {}) {
  // 1. Validate cluster UUID
  if (!clusterId || !UUID_RE.test(clusterId)) {
    const err = new Error('cluster_id must be a valid UUID.');
    err.statusCode = 400;
    throw err;
  }

  // 2. Build context (also validates cluster/document/concepts existence)
  const context = await buildClusterCardContext(clusterId);

  // 3. Check for existing draft
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

  // 4. Determine maxVariants
  let maxVariants = getDefaultMaxVariantsForCluster(context.cluster);
  if (options.max_variants != null) {
    const requested = Number(options.max_variants);
    if (Number.isFinite(requested) && requested >= 1) {
      maxVariants = Math.min(requested, 8);
    }
  }
  // Also cap to the actual number of concepts
  maxVariants = Math.min(maxVariants, context.concepts.length);
  if (maxVariants < 1) maxVariants = 1;

  // 5. Build prompt
  const prompt = buildCardGenerationPrompt(context, { maxVariants });

  // 6. Call Anthropic
  const model =
    process.env.CARD_GENERATION_MODEL ||
    process.env.CONCEPT_EXTRACTION_MODEL ||
    'claude-sonnet-4-20250514';

  const maxTokens = maxVariants <= 3 ? 2500 : maxVariants <= 5 ? 4000 : 5000;

  logger.info('[cardGen] Calling Anthropic', { clusterId, model, maxVariants, maxTokens });

  const anthropic = getAnthropicClient();
  const message = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    temperature: 0.1,
    messages: [{ role: 'user', content: prompt }],
  });

  const rawContent = message.content?.[0]?.text ?? '';

  // 7. Parse JSON
  const parsed = safeJsonParseObject(rawContent);
  if (!parsed) {
    logger.error('[cardGen] Failed to parse LLM response', { clusterId, rawContent: rawContent.slice(0, 500) });
    const err = new Error('LLM returned invalid JSON. Cannot generate card draft.');
    err.statusCode = 502;
    throw err;
  }

  // 8. Validate
  const validation = validateGeneratedCardDraft(parsed, context, maxVariants);
  if (!validation.valid) {
    logger.error('[cardGen] Validation failed', { clusterId, errors: validation.errors });
    const err = new Error(`Card draft validation failed: ${validation.errors.join('; ')}`);
    err.statusCode = 422;
    throw err;
  }

  const validatedOutput = {
    card_group: parsed.card_group,
    validVariants: validation.validVariants,
  };

  // 9. Persist transactionally
  const userId = options.userId ?? null;
  const result = await persistGeneratedCardDraft(context, validatedOutput, userId);

  logger.info('[cardGen] Draft created', {
    clusterId,
    cardId: result.card_group.id,
    variantCount: result.variants.length,
  });

  return {
    status: 'draft_created',
    cluster_id: clusterId,
    card_group: result.card_group,
    variants: result.variants,
  };
}
