import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const BATCH_SIZE    = () => Number(process.env.RECONSTRUCT_BATCH_SIZE    || 4);
const TIMEOUT_MS    = () => Number(process.env.RECONSTRUCT_TIMEOUT_MS    || 120_000);
const MARKDOWN_MODEL = () => process.env.VISUAL_MARKDOWN_MODEL || 'claude-sonnet-4-20250514';

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({
      apiKey:  process.env.ANTHROPIC_API_KEY,
      timeout: TIMEOUT_MS(),
    });
  }
  return _client;
}

const BATCH_PROMPT_PREFIX = `A partir de los siguientes análisis de diapositivas, construí un apunte textual claro para estudiar.

Reglas:
- Mantener el orden de las slides.
- Usar encabezados con el formato exacto: "## Slide {N} — {título}" (o "## Slide {N} — Sin título" si title es null).
- Cada slide debe tener su propia sección aunque el contenido sea breve.
- No inventar información externa; usar solo lo que está en los análisis.
- Explicar relaciones visuales usando diagram_relations y visual_description.
- Conservar fórmulas en formato LaTeX si están presentes.
- Marcar ejemplos con *Ejemplo:* al inicio del párrafo.
- Si warnings contiene "texto ilegible" o "imagen decorativa", mencionarla brevemente.
- El resultado debe ser markdown limpio, sin bloques de código ni comentarios del proceso.

Análisis de diapositivas:
`;

/**
 * Builds a compact slide payload for the prompt, omitting fields that
 * inflate the prompt without adding extraction value.
 * Exported for testing.
 */
export function buildSlidePayload(row) {
  const j = row.structured_json || {};
  const payload = {
    slide_number:       row.slide_number,
    title:              j.title          ?? null,
    visible_text:       j.visible_text   ?? [],
    formulas:           j.formulas       ?? [],
    visual_description: j.visual_description ?? '',
    diagram_relations:  j.diagram_relations  ?? [],
    teacher_intent:     j.teacher_intent     ?? '',
    warnings:           j.warnings           ?? [],
  };
  // Include concepts_candidate only when present (can aid reconstruction context)
  if (Array.isArray(j.concepts_candidate) && j.concepts_candidate.length) {
    payload.concepts_candidate = j.concepts_candidate;
  }
  return payload;
}

/**
 * Reads all slide analyses for a document, calls Claude in batches of
 * RECONSTRUCT_BATCH_SIZE slides (default 4), concatenates the partial
 * markdowns in order, and persists the result in documents.generated_markdown.
 *
 * Throws on failure so the caller can set the document status to 'failed'
 * with a descriptive processing_error that includes the failing slide range.
 */
export async function reconstructMarkdown(documentId) {
  const { rows } = await dbPool.query(
    `SELECT slide_number, structured_json
     FROM document_slides
     WHERE document_id = $1
     ORDER BY slide_number ASC`,
    [documentId]
  );

  if (!rows.length) {
    throw new Error('No slides found for markdown reconstruction.');
  }

  const batchSize = BATCH_SIZE();
  const parts = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch      = rows.slice(i, i + batchSize);
    const firstSlide = batch[0].slide_number;
    const lastSlide  = batch[batch.length - 1].slide_number;
    const t0         = Date.now();

    const userContent = BATCH_PROMPT_PREFIX + JSON.stringify(batch.map(buildSlidePayload), null, 2);

    let partMarkdown;
    try {
      const response = await withRetry(
        () => getClient().messages.create({
          model:       MARKDOWN_MODEL(),
          max_tokens:  2000,
          temperature: 0,
          messages: [{ role: 'user', content: userContent }],
        }),
        { label: `reconstructMarkdown:${documentId}:slides${firstSlide}-${lastSlide}` }
      );

      partMarkdown = response.content
        .map(p => (p.type === 'text' ? p.text : ''))
        .join('\n')
        .trim();

      if (!partMarkdown) {
        throw new Error('Claude returned empty markdown for this batch.');
      }
    } catch (err) {
      throw new Error(
        `Markdown reconstruction failed at slides ${firstSlide}-${lastSlide}: ${err.message}`
      );
    }

    logger.info('[markdownReconstructor] Batch done', {
      documentId,
      slides: `${firstSlide}-${lastSlide}`,
      chars:  partMarkdown.length,
      ms:     Date.now() - t0,
    });

    parts.push(partMarkdown);
  }

  const markdown = parts.join('\n\n');

  await dbPool.query(
    `UPDATE documents SET generated_markdown = $1, updated_at = NOW() WHERE id = $2`,
    [markdown, documentId]
  );

  logger.info('[markdownReconstructor] Markdown stored', {
    documentId,
    slideCount:  rows.length,
    batchCount:  parts.length,
    charCount:   markdown.length,
  });

  return markdown;
}
