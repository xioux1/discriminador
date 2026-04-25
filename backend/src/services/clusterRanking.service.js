import OpenAI from 'openai';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { chunkText, cosineSimilarity, normalizeText } from './conceptExtractor.service.js';

// ==================== Lazy client ====================

let _openai = null;
function getOpenAIClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// ==================== Pure utility functions (exported for testing) ====================

export { cosineSimilarity };

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function computeCentroid(embeddings) {
  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }
  return centroid.map(v => v / embeddings.length);
}

export function computeDensityScore(clusterCentroid, chunkEmbeddings, threshold = 0.70) {
  const similarities = chunkEmbeddings
    .map(chunk => cosineSimilarity(clusterCentroid, chunk.embedding))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);

  if (similarities.length === 0) {
    return { density_score: 0, density_coverage_score: 0, density_intensity_score: 0 };
  }

  const coverage = similarities.filter(s => s >= threshold).length / similarities.length;

  const k = Math.min(5, similarities.length);
  const topK = similarities.slice(0, k);
  const intensity = topK.reduce((sum, s) => sum + s, 0) / k;

  const density = 0.6 * coverage + 0.4 * clamp01(intensity);

  return {
    density_score: clamp01(density),
    density_coverage_score: clamp01(coverage),
    density_intensity_score: clamp01(intensity),
  };
}

export function computeImportanceScore({ density, program, exam }) {
  let score;

  if (program == null && exam == null) {
    score = density;
  } else if (program != null && exam == null) {
    score = density * 0.55 + program * 0.45;
  } else if (program == null && exam != null) {
    score = density * 0.45 + exam * 0.55;
  } else {
    score = density * 0.30 + program * 0.25 + exam * 0.45;
  }

  // Exam is the dominant signal
  if (exam != null && exam >= 0.75) score = Math.max(score, 0.85);
  if (exam != null && exam >= 0.82) score = Math.max(score, 0.92);

  // Strong program match prevents low ranking
  if (program != null && program >= 0.82) score = Math.max(score, 0.75);

  return clamp01(score);
}

export function computePriorityTier(score) {
  if (score >= 0.80) return 'A';
  if (score >= 0.65) return 'B';
  if (score >= 0.45) return 'C';
  return 'D';
}

export function buildImportanceReasons({ density, coverage, intensity, program, exam }) {
  const reasons = [];

  if (density >= 0.75) {
    reasons.push('Alta presencia del cluster en el documento.');
  } else if (density >= 0.50) {
    reasons.push('Presencia moderada del cluster en el documento.');
  } else {
    reasons.push('Baja presencia relativa del cluster en el documento.');
  }

  if (coverage >= 0.50) {
    reasons.push('El cluster aparece distribuido en varios chunks del documento.');
  }

  if (intensity >= 0.80) {
    reasons.push('Algunos fragmentos del documento coinciden fuertemente con el cluster.');
  }

  if (program != null && program >= 0.82) {
    reasons.push('Coincide fuertemente con el programa de la materia.');
  } else if (program != null && program >= 0.72) {
    reasons.push('Tiene coincidencia moderada con el programa de la materia.');
  }

  if (exam != null && exam >= 0.82) {
    reasons.push('Coincide fuertemente con material de examen.');
  } else if (exam != null && exam >= 0.72) {
    reasons.push('Tiene coincidencia moderada con material de examen.');
  }

  return reasons;
}

// ==================== Internal helpers ====================

function parseEmbedding(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/^\[|\]$/g, '').trim();
  if (!cleaned) return null;
  return cleaned.split(',').map(Number);
}

async function createEmbedding(text, model) {
  const response = await getOpenAIClient().embeddings.create({ model, input: text });
  return response.data[0].embedding;
}

async function getDocumentText(document) {
  const directText = document.text || document.content || document.transcript;
  if (directText && directText.trim()) return directText;

  if (document.file_path) {
    const isPdf =
      (document.mime_type && document.mime_type.toLowerCase().includes('pdf')) ||
      document.file_path.toLowerCase().endsWith('.pdf');

    if (isPdf) {
      const { readFile } = await import('node:fs/promises');
      const mod = await import('pdf-parse');
      const PDFParse = mod.PDFParse;
      const buffer = await readFile(document.file_path);
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      if (result && result.text && result.text.trim()) return result.text;
    }
  }

  throw new Error(
    'Cannot extract text from document. Provide text, content, transcript, or a PDF file_path.'
  );
}

async function getOrCreateDocumentChunkEmbeddings(documentId, text, embeddingModel) {
  const chunks = chunkText(text, 300, 50);

  // Batch-fetch all cached embeddings for this document + model in one query
  const { rows: cached } = await dbPool.query(
    `SELECT chunk_index, embedding
     FROM document_chunk_embeddings
     WHERE document_id = $1 AND embedding_model = $2`,
    [documentId, embeddingModel]
  );

  const cacheMap = new Map();
  for (const row of cached) {
    cacheMap.set(row.chunk_index, parseEmbedding(row.embedding));
  }

  const result = [];
  const toEmbed = [];

  for (const chunk of chunks) {
    if (cacheMap.has(chunk.index)) {
      result.push({ chunk_index: chunk.index, chunk_text: chunk.text, embedding: cacheMap.get(chunk.index) });
    } else {
      toEmbed.push(chunk);
    }
  }

  // Embed uncached chunks with limited concurrency
  const CONCURRENCY = 3;
  for (let i = 0; i < toEmbed.length; i += CONCURRENCY) {
    const batch = toEmbed.slice(i, i + CONCURRENCY);
    const embeddings = await Promise.all(batch.map(c => createEmbedding(c.text, embeddingModel)));

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const embedding = embeddings[j];
      const vectorString = `[${embedding.join(',')}]`;

      await dbPool.query(
        `INSERT INTO document_chunk_embeddings
           (document_id, chunk_index, chunk_text, embedding, embedding_model)
         VALUES ($1, $2, $3, $4::vector, $5)
         ON CONFLICT (document_id, chunk_index, embedding_model) DO NOTHING`,
        [documentId, chunk.index, chunk.text, vectorString, embeddingModel]
      );

      result.push({ chunk_index: chunk.index, chunk_text: chunk.text, embedding });
    }
  }

  result.sort((a, b) => a.chunk_index - b.chunk_index);
  return result;
}

// Embeds all chunks of a free-text string. No caching (used for program/exam text).
async function embedTextChunks(text, embeddingModel) {
  const chunks = chunkText(text, 300, 50);
  const CONCURRENCY = 3;
  const result = [];

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const embeddings = await Promise.all(batch.map(c => createEmbedding(c.text, embeddingModel)));
    for (let j = 0; j < batch.length; j++) {
      result.push({ text: batch[j].text, embedding: embeddings[j] });
    }
  }

  return result;
}

// Returns { score, text } for the chunk most similar to centroid, or null if items is empty.
function bestMatch(centroid, items) {
  if (!items || items.length === 0) return null;
  let best = -Infinity;
  let bestText = null;
  for (const item of items) {
    const sim = cosineSimilarity(centroid, item.embedding);
    if (sim > best) {
      best = sim;
      bestText = item.text;
    }
  }
  return { score: best, text: bestText };
}

// ==================== Main pipeline ====================

export async function rankClustersForDocument(documentId) {
  // Step 1 — Fetch document
  const { rows: docRows } = await dbPool.query(
    `SELECT id, text, content, transcript, file_path, mime_type, subject, user_id
     FROM documents WHERE id = $1`,
    [documentId]
  );
  if (!docRows.length) {
    const err = new Error('Document not found.');
    err.statusCode = 404;
    throw err;
  }
  const document = docRows[0];

  // Step 1 — Fetch clusters
  const { rows: clusters } = await dbPool.query(
    `SELECT id, name, definition, document_id
     FROM clusters
     WHERE document_id = $1
     ORDER BY created_at ASC`,
    [documentId]
  );
  if (!clusters.length) {
    const err = new Error('Document has no clusters.');
    err.statusCode = 400;
    throw err;
  }

  // Step 1 — Fetch clustered concepts with embeddings
  const { rows: rawConcepts } = await dbPool.query(
    `SELECT id, label, embedding, embedding_model, cluster_id
     FROM concepts
     WHERE document_id = $1
       AND cluster_id IS NOT NULL
     ORDER BY created_at ASC`,
    [documentId]
  );
  if (!rawConcepts.length) {
    const err = new Error('Document has no clustered concepts.');
    err.statusCode = 400;
    throw err;
  }

  // Validate each cluster has at least one concept
  const conceptsByCluster = new Map();
  for (const c of rawConcepts) {
    if (!conceptsByCluster.has(c.cluster_id)) conceptsByCluster.set(c.cluster_id, []);
    conceptsByCluster.get(c.cluster_id).push(c);
  }

  for (const cluster of clusters) {
    if (!conceptsByCluster.has(cluster.id) || conceptsByCluster.get(cluster.id).length === 0) {
      const err = new Error(`Cluster "${cluster.name}" (${cluster.id}) has no concepts assigned.`);
      err.statusCode = 400;
      throw err;
    }
  }

  // Validate all concepts have embeddings with correct dimensions
  for (const c of rawConcepts) {
    if (!c.embedding) {
      const err = new Error(`Concept "${c.label}" (${c.id}) is missing an embedding.`);
      err.statusCode = 400;
      throw err;
    }
    const emb = parseEmbedding(c.embedding);
    if (!emb || emb.length !== 1536) {
      const err = new Error(
        `Concept "${c.label}" (${c.id}) has an invalid embedding (expected dim 1536, got ${emb ? emb.length : 0}).`
      );
      err.statusCode = 400;
      throw err;
    }
    c._embedding = emb;
  }

  // Validate all concepts use the same embedding_model
  const modelSet = new Set(rawConcepts.map(c => c.embedding_model).filter(Boolean));
  let embeddingModel;
  if (modelSet.size === 0) {
    // embedding_model not tracked in this project version; fall back to env default
    embeddingModel = process.env.CONCEPT_EMBEDDING_MODEL || 'text-embedding-3-small';
  } else if (modelSet.size > 1) {
    const err = new Error(
      'Concepts for this document use multiple embedding models. Cannot rank clusters safely.'
    );
    err.statusCode = 400;
    throw err;
  } else {
    embeddingModel = [...modelSet][0];
  }

  logger.info('[clusterRanking] Starting', {
    documentId,
    clusterCount: clusters.length,
    conceptCount: rawConcepts.length,
    embeddingModel,
  });

  // Step 2 — Compute centroid per cluster
  for (const cluster of clusters) {
    const clusterConcepts = conceptsByCluster.get(cluster.id);
    cluster._centroid = computeCentroid(clusterConcepts.map(c => c._embedding));
  }

  // Step 3 — Get document text
  const rawText = await getDocumentText(document);
  const text = normalizeText(rawText);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 20) {
    const err = new Error('Document does not contain enough text for cluster ranking.');
    err.statusCode = 400;
    throw err;
  }

  // Step 4 — Get or create cached document chunk embeddings
  logger.info('[clusterRanking] Building chunk embeddings', { documentId, wordCount });
  const chunkEmbeddings = await getOrCreateDocumentChunkEmbeddings(documentId, text, embeddingModel);

  const densityThreshold = Number(process.env.CLUSTER_DENSITY_SIMILARITY_THRESHOLD || 0.70);

  // Steps 6–7 — Fetch subject context (program + exams) if document has a linked subject
  let programItems = null;
  let examItems = null;

  if (document.subject && document.user_id) {
    const [configResult, examsResult] = await Promise.all([
      dbPool.query(
        'SELECT syllabus_text FROM subject_configs WHERE subject = $1 AND user_id = $2',
        [document.subject, document.user_id]
      ),
      dbPool.query(
        'SELECT content_text, label FROM reference_exams WHERE subject = $1 AND user_id = $2 ORDER BY created_at DESC',
        [document.subject, document.user_id]
      ),
    ]);

    const config = configResult.rows[0];
    const exams = examsResult.rows;

    if (config && config.syllabus_text && config.syllabus_text.trim()) {
      logger.info('[clusterRanking] Embedding program/syllabus chunks', { documentId });
      programItems = await embedTextChunks(normalizeText(config.syllabus_text), embeddingModel);
    }

    if (exams.length > 0) {
      logger.info('[clusterRanking] Embedding exam chunks', { documentId, examCount: exams.length });
      const allExamItems = [];
      for (const exam of exams) {
        if (exam.content_text && exam.content_text.trim()) {
          const items = await embedTextChunks(normalizeText(exam.content_text), embeddingModel);
          allExamItems.push(...items);
        }
      }
      if (allExamItems.length > 0) examItems = allExamItems;
    }
  }

  // Steps 5–12 — Score each cluster and persist
  const ranked = [];

  for (const cluster of clusters) {
    const centroid = cluster._centroid;

    // Step 5: density
    const density = computeDensityScore(centroid, chunkEmbeddings, densityThreshold);

    // Step 6: program
    let program_score = null;
    if (programItems && programItems.length > 0) {
      const match = bestMatch(centroid, programItems);
      if (match) program_score = clamp01(match.score);
    }

    // Step 7: exam
    let exam_score = null;
    if (examItems && examItems.length > 0) {
      const match = bestMatch(centroid, examItems);
      if (match) exam_score = clamp01(match.score);
    }

    // Step 8: final score
    const importance_score = computeImportanceScore({
      density: density.density_score,
      program: program_score,
      exam: exam_score,
    });

    // Step 9: tier
    const priority_tier = computePriorityTier(importance_score);

    // Step 10: reasons
    const importance_reasons = buildImportanceReasons({
      density: density.density_score,
      coverage: density.density_coverage_score,
      intensity: density.density_intensity_score,
      program: program_score,
      exam: exam_score,
    });

    // Step 11: persist
    await dbPool.query(
      `UPDATE clusters
       SET density_score           = $1,
           density_coverage_score  = $2,
           density_intensity_score = $3,
           program_score           = $4,
           exam_score              = $5,
           importance_score        = $6,
           priority_tier           = $7,
           importance_reasons      = $8::jsonb,
           importance_computed_at  = NOW()
       WHERE id = $9`,
      [
        density.density_score,
        density.density_coverage_score,
        density.density_intensity_score,
        program_score,
        exam_score,
        importance_score,
        priority_tier,
        JSON.stringify(importance_reasons),
        cluster.id,
      ]
    );

    ranked.push({
      id: cluster.id,
      name: cluster.name,
      definition: cluster.definition,
      density_score: density.density_score,
      density_coverage_score: density.density_coverage_score,
      density_intensity_score: density.density_intensity_score,
      program_score,
      exam_score,
      importance_score,
      priority_tier,
      importance_reasons,
    });
  }

  // Step 14: return sorted by importance_score DESC
  ranked.sort((a, b) => b.importance_score - a.importance_score);

  logger.info('[clusterRanking] Done', { documentId, clusterCount: ranked.length });

  return {
    status: 'completed',
    document_id: documentId,
    cluster_count: ranked.length,
    clusters: ranked,
  };
}
