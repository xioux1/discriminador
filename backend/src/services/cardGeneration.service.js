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
  if (tier === 'A') return 9;
  if (tier === 'B') return 7;
  if (tier === 'C') return 5;
  if (tier === 'D') return 3;
  return 9;
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

  // Fetch concepts for this cluster — ordered so main/support appear before examples
  const { rows: conceptRows } = await dbPool.query(
    `SELECT id, label, definition, evidence, source_chunk, source_chunk_index,
            role_in_cluster, concept_type
     FROM concepts
     WHERE cluster_id = $1
     ORDER BY
       CASE role_in_cluster
         WHEN 'main'    THEN 0
         WHEN 'support' THEN 1
         WHEN 'context' THEN 2
         WHEN 'example' THEN 3
         ELSE 4
       END,
       source_chunk_index ASC NULLS LAST`,
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

  // Fetch intra-cluster semantic relations
  const conceptIds = conceptRows.map(c => c.id);
  const { rows: relationRows } = await dbPool.query(
    `SELECT source_concept_id, target_concept_id, relation_type, confidence, rationale
     FROM concept_relations
     WHERE source_concept_id = ANY($1::uuid[])
       AND target_concept_id = ANY($1::uuid[])
     ORDER BY confidence DESC`,
    [conceptIds]
  );

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
      role_in_cluster: c.role_in_cluster ?? null,
      concept_type: c.concept_type ?? null,
    })),
    relations: relationRows.map(r => ({
      from: r.source_concept_id,
      to:   r.target_concept_id,
      type: r.relation_type,
      confidence: r.confidence,
      rationale: r.rationale,
    })),
    source_excerpts: sourceExcerpts,
  };
}

// ==================== detectEnumerativeCluster ====================

const ENUM_SIGNALS = [
  'fase', 'etapa', 'proceso', 'metodología', 'metodologia',
  'secuencia', 'paso', 'pasos', 'opcion', 'opción', 'opciones',
  'tipo', 'tipos', 'herramienta', 'herramientas', 'entregable', 'entregables',
  'flujo', 'flujos', 'componente', 'componentes', 'workflow',
  'ciclo', 'etapas', 'fases', 'procedimiento', 'implementacion', 'implementación',
];

/**
 * Returns true when the cluster name, definition, or concept labels/definitions
 * contain signals that suggest the cluster has an enumerative structure
 * (phases, steps, types, tools, deliverables, etc.).
 * Exported for testing.
 */
export function detectEnumerativeCluster(context) {
  const text = [
    context.cluster?.name ?? '',
    context.cluster?.definition ?? '',
    ...(context.concepts ?? []).map(c => c.label ?? ''),
    ...(context.concepts ?? []).map(c => c.definition ?? ''),
  ].join(' ').toLowerCase();
  return ENUM_SIGNALS.some(s => text.includes(s));
}

// ==================== buildCardGenerationPrompt ====================

export function buildCardGenerationPrompt(context, options = {}) {
  const { cluster, concepts, relations = [], source_excerpts } = context;
  const maxVariants = options.maxVariants ?? 5;
  const isEnumerative = detectEnumerativeCluster(context);
  const minCoverage = Math.max(
    Math.min(2, concepts.length),
    Math.min(Math.floor(concepts.length * 0.5), maxVariants * 3),
  );

  const clusterJson = JSON.stringify({
    id: cluster.id,
    name: cluster.name,
    definition: cluster.definition,
  }, null, 2);

  const conceptsJson = JSON.stringify(
    concepts.map(c => {
      const entry = {
        id: c.id,
        label: c.label,
        definition: c.definition,
        evidence: c.evidence,
        source_chunk_index: c.source_chunk_index,
      };
      if (c.role_in_cluster) entry.role_in_cluster = c.role_in_cluster;
      if (c.concept_type)    entry.concept_type    = c.concept_type;
      return entry;
    }),
    null,
    2
  );

  // Determine if the cluster is predominantly non-generatable (all examples/calc steps)
  const hasNonExampleConcepts = concepts.some(
    c => c.role_in_cluster !== 'example' && c.concept_type !== 'calculation_step'
  );

  const relationsSection = relations.length > 0
    ? `\nRelaciones semánticas entre conceptos:\n${JSON.stringify(
        relations.map(r => ({ from: r.from, to: r.to, type: r.type, rationale: r.rationale })),
        null, 2
      )}\n`
    : '';

  const sourceExcerptsJson = JSON.stringify(source_excerpts, null, 2);

  const targetVariants = Math.max(6, Math.min(7, maxVariants));

  return `Sos un asistente experto en diseño de tarjetas de estudio.

Vas a recibir un cluster de conceptos extraídos de un documento de estudio.
Tu tarea es generar UNA familia de tarjeta y VARIAS variantes de pregunta/respuesta para que un alumno entienda completamente ese cluster.

Objetivo principal:
El alumno tiene que poder estudiar el cluster respondiendo estas preguntas. Para eso necesitás SUFICIENTES preguntas atómicas, no pocas preguntas amplias. Apuntá a generar entre ${targetVariants} y ${maxVariants} variantes si el material lo permite. Más preguntas atómicas bien específicas son siempre mejor que menos preguntas vagas que abarcan demasiado.

Tiempo de respuesta objetivo:
Cada pregunta debe poder responderse en 30 a 40 segundos si el alumno sabe la respuesta. Si una respuesta tarda más, la pregunta es demasiado amplia: dividila.

Especificidad obligatoria de las preguntas:
Cada pregunta DEBE ser autocontenida: tiene que mencionar explícitamente el tema, método, tipo o contexto específico que está evaluando, sin asumir que el alumno sabe de qué cluster viene la pregunta. Si la misma pregunta podría aparecer en otro tema sin cambiar nada, es demasiado genérica.
- MAL: "¿Cómo resolver una ecuación con factor integrante?"
- BIEN: "¿Cómo resolver una ecuación diferencial exacta usando factor integrante?"
- MAL: "¿Qué es la transformada inversa?"
- BIEN: "¿Qué es la transformada inversa de Laplace y para qué se usa?"

Reglas estrictas:
1. Usá sólo el material provisto. No inventes datos externos.
2. No expandas ni extrapoles más allá de la evidencia textual disponible.
3. Cada afirmación de la respuesta debe poder rastrearse a source_concept_ids y source_chunk_indexes.
4. Formato de expected_answer según el tipo de pregunta:
   - Si la pregunta pide una lista, enumeración o conjunto de elementos independientes → usá bullets (3 a 5 ítems, 4–18 palabras cada uno). EXCEPCIÓN: las preguntas de enumeración estructural (ver regla 11) pueden tener hasta 8 bullets.
   - Si la pregunta pide explicar un mecanismo, una relación causal, un propósito o un razonamiento → respondé en prosa: 2 a 4 oraciones que articulen la idea central con su contexto. Sin bullets.
   - No mezcles ambos formatos en la misma respuesta.
   - Nunca copies los bullets del documento fuente. Si la respuesta en prosa requiere mencionar varios elementos, integralos en la oración (ej: "depende de X, Y y Z").
5. Las preguntas deben ser abiertas, no multiple choice, no verdadero/falso.
6. Cada pregunta debe evaluar comprensión, no repetición mecánica.
7. (incorporado en regla 4)
8. (incorporado en regla 4)
9. Cada expected_answer completo debe tener aproximadamente 20–110 palabras.
10. No generes variantes duplicadas.
11. Cada variante debe evaluar UN SOLO concepto o mecanismo atómico. Si una pregunta requeriría listar 4 o más elementos independientes para contestarse, NO es una variante válida: dividila en varias preguntas separadas. No combines conceptos salvo que sean definitoriamente inseparables (ej: un término y su única definición posible).
    EXCEPCIÓN — enumeración estructural: si el cluster representa una metodología, proceso, taxonomía o estructura con elementos nombrados, podés generar UNA sola pregunta de enumeración estructural del tipo "¿Cuáles son las fases/etapas/opciones/herramientas/flujos de X?". Esa card puede tener hasta 8 bullets en la respuesta. Si hay más de 8 elementos en la fuente, limitá a los principales. Esta excepción aplica solo UNA VEZ por familia de cards.
12. Cada variante debe incluir una rúbrica de corrección con 3 a 6 bullets.
13. La rúbrica debe indicar elementos mínimos para aprobar, en frases cortas.
14. No generes más de ${maxVariants} variantes.
15. Cada variante debe incluir en source_concept_ids TODOS los conceptos que toca, evalúa o presupone — no sólo el concepto principal. La validación exige que entre TODAS las variantes se cubran al menos ${minCoverage} conceptos únicos del cluster (de ${concepts.length} disponibles). Distribuí los conceptos entre variantes para alcanzar esa cobertura mínima.
16. Cada variante debe incluir source_chunk_indexes usando sólo índices reales provistos.
17. Si no hay source_chunk_index disponible para una variante, usar [].
18. Cada variante debe incluir tag_labels (2 a 5 etiquetas cortas, snake_case) para tagging posterior.
19. No modifiques los UUIDs.
20. Respondé sólo con JSON. Sin markdown, sin backticks, sin texto adicional.
${hasNonExampleConcepts
  ? `21. Los conceptos con role_in_cluster "example" o concept_type "calculation_step" son material de soporte, no el foco de estudio. No generes preguntas cuyo único source_concept_id sea uno de esos conceptos. Usálos como evidencia dentro de preguntas sobre conceptos "main" o "support". Si un ejemplo ilustra un mecanismo central, la pregunta debe ser sobre el mecanismo, no sobre los pasos del ejemplo.`
  : `21. Todos los conceptos de este cluster son ejemplos o pasos de cálculo. Generá preguntas que ayuden al alumno a entender el procedimiento o el ejemplo, orientándolas a comprensión del método general, no a memorización de pasos individuales.`
}${isEnumerative ? `
22-enum. Este cluster tiene estructura enumerativa (fases, etapas, opciones, herramientas, flujos, componentes u otro conjunto nombrado). Generá AL MENOS UNA variante de enumeración estructural con pregunta del tipo "¿Cuáles son las [fases/etapas/opciones/herramientas/flujos/entregables] de [X]?". Reglas para esa variante:
   - Solo incluí elementos que aparezcan explícitamente en source_excerpts. No inventes.
   - Si el documento usa sinónimos, incluirlos en el mismo bullet (ej: "GoLive / Entrada en producción").
   - Si hay más de 8 elementos, limitá a los más importantes.
   - La respuesta debe ser una lista limpia de bullets (hasta 8).
   - Priorizá esta variante como primera o segunda del array.` : ''}${relationsSection ? `
22. Usá las relaciones semánticas provistas para estructurar las preguntas:
   - "example_of": la pregunta sobre el concepto target puede usar el source como evidencia concreta; no preguntes sobre el ejemplo en sí.
   - "motivates": generá preguntas que conecten el problema (source) con la solución (target) — "¿por qué X llevó a Y?".
   - "contrasts_with": considerá una variante que explore la diferencia entre los dos conceptos.
   - "depends_on": asegurate de que la pregunta sobre source presuponga o mencione target como contexto.
   - "part_of" / "formula_for": anclar preguntas de detalle al todo que explican.
   Las relaciones son hints; priorizá siempre la comprensión del alumno.` : ''}

Tipo de card:
Clasificá cada familia de tarjeta como "theoretical_open" o "practical_exercise".
- "theoretical_open": el alumno explica, define o describe un concepto (sin ejecutar nada).
- "practical_exercise": el alumno debe producir algo concreto — escribir código/SQL, resolver un ejercicio numérico paso a paso, aplicar un algoritmo, completar una transformación. Si la respuesta esperada es código, una query, una derivación algebraica paso a paso o un cálculo con pasos intermedios, usá "practical_exercise".

Idioma:
español

Formato exacto de salida:
{
  "card_group": {
    "title": "título breve de la familia de tarjeta",
    "card_type": "theoretical_open | practical_exercise"
  },
  "variants": [
    {
      "question": "pregunta abierta autocontenida con tema específico",
      "expected_answer": "- item 1\n- item 2\n- item 3",
      "grading_rubric": [
        "criterio 1",
        "criterio 2",
        "criterio 3"
      ],
      "source_concept_ids": ["uuid"],
      "source_chunk_indexes": [1],
      "tag_labels": ["etiqueta_1", "etiqueta_2"],
      "difficulty": "easy|medium|hard",
      "answer_time_seconds": 35
    }
  ]
}

Datos del cluster:
${clusterJson}

Conceptos:
${conceptsJson}
${relationsSection}
Fragmentos fuente:
${sourceExcerptsJson}

Recordá:
- El objetivo es cubrir bien el cluster con SUFICIENTES preguntas atómicas. Apuntá a ${targetVariants}–${maxVariants} variantes.
- Si una pregunta se puede dividir en dos preguntas más específicas, dividila siempre.
- Priorizá claridad y escaneabilidad para revisión rápida y etiquetado.
- No conviertas un concepto amplio en una sola pregunta que lo abarca todo: hacé una pregunta por cada aspecto importante.
- Señal de error: si una variante tiene 5+ conceptos distintos en source_concept_ids, casi siempre es una card que debería haberse dividido. Revisá y dividila.
- Una pregunta tipo "¿cómo se implementa X completo?" que requiere transformación inversa + Jacobiano + integrando + región + integral es 5 cards, no 1.
- Cada pregunta debe nombrarse con el contexto suficiente para que el alumno sepa exactamente de qué tema es, sin ver el cluster.`;
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

  const VALID_CARD_TYPES = ['theoretical_open', 'practical_exercise'];
  if (!VALID_CARD_TYPES.includes(card_type)) {
    errors.push(`card_group.card_type must be one of ${VALID_CARD_TYPES.map(t => `"${t}"`).join(', ')}, got "${card_type}"`);
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
  // Cap by maxVariants * 3 so large clusters with few allowed variants don't
  // demand unreachable coverage (e.g. 22 concepts, tier-B = 3 variants → cap at 9,
  // not 11). Always require at least 2 covered unless the cluster has only 1 concept.
  const minCoverage = Math.max(
    Math.min(2, context.concepts.length),
    Math.min(Math.floor(context.concepts.length * 0.5), maxVariants * 3),
  );

  const seenQuestions = new Set();
  const validVariants = [];
  const coveredConcepts = new Set();
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
      let bullets = v.expected_answer
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^[-*•]\s+/.test(line));

      if (bullets.length > 8) {
        logger.warn(`[cardGen] variant ${i}: trimming expected_answer from ${bullets.length} to 8 bullets`);
        bullets = bullets.slice(0, 8);
        v.expected_answer = bullets.join('\n');
      }

      const wordCount = v.expected_answer.trim().split(/\s+/).length;
      if (wordCount < 20 || wordCount > 110) {
        vErrs.push(`expected_answer has ${wordCount} words (expected 20–110)`);
      }

      if (bullets.length === 0) {
        // formato prosa: exigir 20–110 palabras (ya validado arriba) y al menos 2 oraciones
        const sentences = v.expected_answer.trim().split(/[.?!]+/).filter(s => s.trim().length > 0);
        if (sentences.length < 2) {
          vErrs.push(`expected_answer en prosa debe tener al menos 2 oraciones, tiene ${sentences.length}`);
        }
      } else if (bullets.length < 3) {
        vErrs.push(`expected_answer tiene formato ambiguo: ${bullets.length} bullet(s) (debe tener 0 para prosa o 3–8 para lista)`);
      } else {
        for (const bullet of bullets) {
          const bulletWords = bullet.replace(/^[-*•]\s+/, '').split(/\s+/).filter(Boolean).length;
          if (bulletWords < 4 || bulletWords > 18) {
            vErrs.push(`expected_answer bullet has ${bulletWords} words (expected 4–18)`);
            break;
          }
        }
      }

      const questionWords = (v.question || '').trim().split(/\s+/).filter(Boolean).length || 1;
      const relLength = wordCount / questionWords;
      if (relLength > 6) {
        vErrs.push(`expected_answer too long relative to question (ratio ${relLength.toFixed(2)}, max 6)`);
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
      if (v.source_concept_ids.length === 0) {
        vErrs.push('source_concept_ids must contain at least one concept');
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

    if (!Array.isArray(v.tag_labels) || v.tag_labels.length < 2 || v.tag_labels.length > 5) {
      vErrs.push(`tag_labels must have 2–5 items, got ${Array.isArray(v.tag_labels) ? v.tag_labels.length : 'non-array'}`);
    } else {
      const invalidTags = v.tag_labels.filter((tag) => typeof tag !== 'string' || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(tag));
      if (invalidTags.length > 0) {
        vErrs.push('tag_labels must be snake_case strings');
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
      for (const conceptId of v.source_concept_ids) coveredConcepts.add(conceptId);
    }
  }

  if (validVariants.length === 0) {
    return {
      valid: false,
      errors: ['No valid variants after validation', ...variantErrors.map(e => `v${e.index}: ${e.errors.join('; ')}`)],
      validVariants: [],
    };
  }

  if (coveredConcepts.size < minCoverage) {
    return {
      valid: false,
      errors: [
        `Concept coverage too low: ${coveredConcepts.size}/${context.concepts.length} (minimum ${minCoverage})`,
      ],
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
          cluster_id, document_id, card_type, status, grading_rubric)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8)
       RETURNING id`,
      [
        userId ?? null,
        document.subject_name ?? null,
        primaryVariant.question,
        primaryVariant.expected_answer,
        cluster.id,
        document.id,
        card_group.card_type,
        JSON.stringify(primaryVariant.grading_rubric ?? []),
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
