import Anthropic from '@anthropic-ai/sdk';
import { createEmbedding as voyageEmbed } from '../utils/voyage-embed.js';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

// ==================== Lazy clients ====================

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.CONCEPT_LLM_TIMEOUT_MS || 30_000),
  });
  return _anthropic;
}

// Lazy-load pdf-parse (v2 ESM-friendly import)
let _PDFParse = null;
async function getPDFParse() {
  if (!_PDFParse) {
    const mod = await import('pdf-parse');
    _PDFParse = mod.PDFParse;
  }
  return _PDFParse;
}

// ==================== Pure utility functions (exported for testing) ====================

export function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function chunkText(text, windowSize = 300, overlap = 50) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;

  while (i < words.length) {
    const chunkWords = words.slice(i, i + windowSize);
    if (chunkWords.length > 0) {
      chunks.push({ index: chunks.length, text: chunkWords.join(' ') });
    }
    i += windowSize - overlap;
  }

  return chunks;
}

export function safeJsonParseArray(raw) {
  if (!raw || typeof raw !== 'string') return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {}

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');

  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
  }

  return [];
}

const GENERIC_LABELS_EXACT = new Set([
  'introducción',
  'conceptos básicos',
  'aspectos generales',
  'tema principal',
  'resumen general',
  'generalidades',
  'contenido general',
  'material de estudio',
  'clase teórica',
  'explicación general',
]);

const WEAK_STARTS = [
  'introducción a',
  'conceptos de',
  'aspectos de',
  'generalidades de',
];

// ── Concept type / importance vocabulary ──────────────────────────────────────

export const VALID_CONCEPT_TYPES = new Set([
  'core_concept',
  'sub_concept',
  'example',
  'formula',
  'calculation_step',
  'implementation_detail',
  'limitation',
  'architecture_component',
  'method_or_technique',
]);

export const VALID_IMPORTANCE = new Set(['high', 'medium', 'low']);

export function validateConcept(rawConcept, sourceChunk, sourceChunkIndex) {
  if (!rawConcept || typeof rawConcept !== 'object') return null;

  let label = rawConcept.label;
  let definition = rawConcept.definition;
  const rawEvidence = rawConcept.evidence;

  if (!label || typeof label !== 'string') return null;
  if (!definition || typeof definition !== 'string') return null;

  // Normalize label: strip wrapping quotes, collapse whitespace
  label = label.trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').trim();
  definition = definition.trim().replace(/\s+/g, ' ');

  if (!label || !definition) return null;

  // Validate word count: 4 to 8 words
  const labelWords = label.split(/\s+/).filter(Boolean);
  if (labelWords.length < 4 || labelWords.length > 8) return null;

  const normalized = label.toLowerCase();

  // Reject exact generic labels
  if (GENERIC_LABELS_EXACT.has(normalized)) return null;

  // Reject labels that contain a generic label as exact substring match
  for (const g of GENERIC_LABELS_EXACT) {
    if (normalized === g) return null;
  }

  // Reject if weak start leads to a generic-looking label (4 words or fewer after the prefix)
  for (const s of WEAK_STARTS) {
    if (normalized.startsWith(s)) {
      const rest = normalized.slice(s.length).trim().split(/\s+/).filter(Boolean);
      if (rest.length === 0) return null;
    }
  }

  // Definition must have at least 8 words
  const defWords = definition.split(/\s+/).filter(Boolean);
  if (defWords.length < 8) return null;

  // Ensure definition ends with punctuation
  if (!/[.!?]$/.test(definition)) definition += '.';

  const evidence = typeof rawEvidence === 'string' && rawEvidence.trim() ? rawEvidence.trim() : null;

  const concept_type = VALID_CONCEPT_TYPES.has(rawConcept.concept_type)
    ? rawConcept.concept_type
    : null;
  const importance = VALID_IMPORTANCE.has(rawConcept.importance)
    ? rawConcept.importance
    : null;

  return {
    label,
    definition,
    evidence,
    source_chunk: sourceChunk,
    source_chunk_index: sourceChunkIndex,
    concept_type,
    importance,
  };
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function labelScore(label) {
  const normalized = label.toLowerCase().trim();
  const words = normalized.split(/\s+/).filter(Boolean);

  let score = 0;

  if (words.length >= 4 && words.length <= 8) score += 3;
  score += Math.min(words.length, 8);

  for (const g of GENERIC_LABELS_EXACT) {
    if (normalized === g) { score -= 10; break; }
    if (normalized.includes(g)) score -= 3;
  }

  for (const s of WEAK_STARTS) {
    if (normalized.startsWith(s)) score -= 2;
  }

  return score;
}

function chooseBestConcept(a, b) {
  const scoreA = labelScore(a.label);
  const scoreB = labelScore(b.label);
  if (scoreA > scoreB) return a;
  if (scoreB > scoreA) return b;
  // Tiebreak: prefer longer label as more descriptive
  return b.label.length > a.label.length ? b : a;
}

export function deduplicateConcepts(concepts, threshold = 0.86) {
  const canonical = [];

  for (const concept of concepts) {
    let merged = false;
    for (let i = 0; i < canonical.length; i++) {
      const sim = cosineSimilarity(concept.embedding, canonical[i].embedding);
      if (sim >= threshold) {
        canonical[i] = chooseBestConcept(canonical[i], concept);
        merged = true;
        break;
      }
    }
    if (!merged) {
      canonical.push(concept);
    }
  }

  return canonical;
}

// ==================== I/O helpers ====================

async function getDocumentText(document) {
  // 1. Direct text fields
  const directText = document.text || document.content || document.transcript;
  if (directText && directText.trim()) return directText;

  // 2. PDF via file_path
  if (document.file_path) {
    const isPdf =
      (document.mime_type && document.mime_type.toLowerCase().includes('pdf')) ||
      document.file_path.toLowerCase().endsWith('.pdf');

    if (isPdf) {
      const { readFile } = await import('node:fs/promises');
      const PDFParse = await getPDFParse();
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

function buildConceptPrompt(chunk) {
  return `Dado el siguiente fragmento de material de estudio, extraé los temas principales tratados.

Cada tema debe ser:
- lo suficientemente amplio como para agrupar subtemas relacionados
- lo suficientemente específico como para distinguirse de otros temas del documento
- útil como etiqueta de organización para estudiar

El texto puede tener errores, cortes o ruido de transcripción. Ignorá el ruido, pero no inventes temas que no estén apoyados por el fragmento.

Para cada tema:
- "label": nombre descriptivo de 4 a 8 palabras, nunca una sola palabra
- "definition": qué cubre este tema en una oración completa
- "evidence": frase breve o fragmento del texto que justifica el tema
- "concept_type": tipo del tema según su naturaleza. Elegí exactamente uno de estos valores:
  "core_concept" | "sub_concept" | "example" | "formula" | "calculation_step" |
  "implementation_detail" | "limitation" | "architecture_component" | "method_or_technique"
- "importance": importancia didáctica del tema. Elegí exactamente uno: "high" | "medium" | "low"

Guía para concept_type:
- core_concept: tema central e independiente, pilar conceptual del fragmento
- sub_concept: aspecto, variante o extensión de un concepto central
- example: ejemplo concreto, ilustración, analogía o caso de uso
- formula: expresión matemática, ecuación o relación formal nombrada
- calculation_step: paso intermedio de un cálculo o derivación algebraica
- implementation_detail: detalle de implementación, configuración o código
- limitation: restricción, desventaja o caso borde de un concepto
- architecture_component: componente de una arquitectura (capa, módulo, bloque, cabeza de atención)
- method_or_technique: procedimiento, técnica o algoritmo con nombre propio

Reglas:
- No uses conocimiento externo.
- No generes más de 6 temas por fragmento. Si el fragmento desarrolla un único ejemplo extenso,
  extraé el concepto central que ilustra y como máximo 2 pasos del ejemplo marcados como
  "calculation_step" o "example" — no uno por cada paso.
- No generes temas demasiado genéricos como "Introducción", "Conceptos básicos", "Aspectos generales", "Tema principal" o "Resumen general".
- Si el fragmento no contiene contenido conceptual suficiente, devolvé [].
- El campo "evidence" debe contener texto que aparezca o esté claramente basado en el fragmento.
- No devuelvas objetos fuera del array.
- No agregues comentarios.

Respondé SOLO con un JSON array. Sin texto adicional, sin markdown, sin backticks.

Fragmento:
${chunk}`;
}

async function callAnthropicConceptExtraction(chunkText) {
  const model = process.env.CONCEPT_EXTRACTION_MODEL || 'claude-sonnet-4-20250514';

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model,
      max_tokens: 1200,
      temperature: 0.1,
      messages: [{ role: 'user', content: buildConceptPrompt(chunkText) }],
    }),
    { label: 'callAnthropicConceptExtraction' },
  );

  return response.content
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
}

export async function createEmbedding(text) {
  const model = process.env.CONCEPT_EMBEDDING_MODEL || 'voyage-large-2';
  return voyageEmbed(text, model);
}

async function getDocumentById(documentId) {
  const { rows } = await dbPool.query('SELECT * FROM documents WHERE id = $1', [documentId]);
  return rows[0] || null;
}

async function deleteConceptsForDocument(documentId) {
  await dbPool.query('DELETE FROM concepts WHERE document_id = $1', [documentId]);
}

async function insertConcept(documentId, concept) {
  const { label, definition, source_chunk, source_chunk_index, evidence, embedding, concept_type, importance } = concept;
  const extractionModel = process.env.CONCEPT_EXTRACTION_MODEL || 'claude-sonnet-4-20250514';
  const embeddingModel = process.env.CONCEPT_EMBEDDING_MODEL || 'voyage-large-2';
  const vectorString = `[${embedding.join(',')}]`;

  const { rows } = await dbPool.query(
    `INSERT INTO concepts (
       document_id, label, definition, source_chunk, source_chunk_index,
       evidence, cluster_id, embedding, extraction_model, embedding_model, status,
       concept_type, importance
     ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7::vector, $8, $9, 'accepted', $10, $11)
     RETURNING *`,
    [documentId, label, definition, source_chunk, source_chunk_index,
     evidence, vectorString, extractionModel, embeddingModel,
     concept_type ?? null, importance ?? null]
  );

  return rows[0];
}

// ==================== Public API ====================

export async function extractConceptsForDocument(documentId) {
  const document = await getDocumentById(documentId);
  if (!document) throw new Error('Document not found');

  logger.info('[conceptExtractor] Starting extraction', { documentId });

  const rawText = await getDocumentText(document);
  const text = normalizeText(rawText);

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount < 20) {
    throw new Error('Document does not contain enough text for concept extraction.');
  }

  logger.info('[conceptExtractor] Text ready', { documentId, wordCount });

  const chunks = chunkText(text, 300, 50);
  logger.info('[conceptExtractor] Chunked', { documentId, chunkCount: chunks.length });

  const extractedConcepts = [];
  let failedChunks = 0;

  const CHUNK_CONCURRENCY = Number(process.env.CONCEPT_CHUNK_CONCURRENCY || 5);
  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(chunk => callAnthropicConceptExtraction(chunk.text))
    );
    results.forEach((result, j) => {
      const chunk = batch[j];
      if (result.status === 'fulfilled') {
        const parsed = safeJsonParseArray(result.value);
        for (const rawConcept of parsed) {
          const valid = validateConcept(rawConcept, chunk.text, chunk.index);
          if (valid) extractedConcepts.push(valid);
        }
      } else {
        failedChunks++;
        logger.warn('[conceptExtractor] Chunk failed', {
          documentId, chunkIndex: chunk.index, error: result.reason?.message,
        });
      }
    });
  }

  if (failedChunks > 0) {
    logger.warn('[conceptExtractor] Some chunks failed', { documentId, failedChunks });
  }

  logger.info('[conceptExtractor] Extracted (pre-dedup)', {
    documentId, count: extractedConcepts.length,
  });

  const EMBED_CONCURRENCY = Number(process.env.CONCEPT_EMBED_CONCURRENCY || 10);
  const conceptsWithEmbeddings = [];
  for (let i = 0; i < extractedConcepts.length; i += EMBED_CONCURRENCY) {
    const batch = extractedConcepts.slice(i, i + EMBED_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(c => createEmbedding(`${c.label}. ${c.definition}`))
    );
    results.forEach((result, j) => {
      const concept = batch[j];
      if (result.status === 'fulfilled') {
        conceptsWithEmbeddings.push({ ...concept, embedding: result.value });
      } else {
        logger.warn('[conceptExtractor] Embedding failed, skipping concept', {
          documentId, label: concept.label, error: result.reason?.message,
        });
      }
    });
  }

  const threshold = Number(process.env.CONCEPT_DEDUP_THRESHOLD || 0.86);
  const canonicalConcepts = deduplicateConcepts(conceptsWithEmbeddings, threshold);

  logger.info('[conceptExtractor] After dedup', {
    documentId, count: canonicalConcepts.length,
  });

  await deleteConceptsForDocument(documentId);

  const saved = [];
  for (const concept of canonicalConcepts) {
    const inserted = await insertConcept(documentId, concept);
    saved.push(inserted);
  }

  logger.info('[conceptExtractor] Done', { documentId, saved: saved.length });

  return saved;
}

export async function getDocumentConcepts(documentId) {
  const { rows } = await dbPool.query(
    `SELECT id, label, definition, evidence, source_chunk_index, cluster_id, created_at
     FROM concepts
     WHERE document_id = $1
     ORDER BY source_chunk_index ASC NULLS LAST, created_at ASC`,
    [documentId]
  );
  return rows;
}
