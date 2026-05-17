import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { MARKDOWN_RECONSTRUCTION_PROMPT } from '../utils/visual-prompts.js';

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({
      apiKey:   process.env.ANTHROPIC_API_KEY,
      timeout:  Number(process.env.VISUAL_LLM_TIMEOUT_MS || 60_000),
    });
  }
  return _client;
}

const MARKDOWN_MODEL = () => process.env.VISUAL_MARKDOWN_MODEL || 'claude-sonnet-4-6';

/**
 * Reads all slide analyses for a document, calls Claude to produce
 * a synthetic study markdown, and persists it in documents.generated_markdown.
 *
 * Throws on failure so the caller (visualProcessor) can set the document
 * status to 'failed' with a descriptive processing_error.
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

  // Build a compact but readable representation for the prompt
  const slidePayload = rows.map(r => ({
    slide_number:    r.slide_number,
    ...(r.structured_json || {}),
  }));

  const userContent = MARKDOWN_RECONSTRUCTION_PROMPT + JSON.stringify(slidePayload, null, 2);

  const response = await withRetry(
    () => getClient().messages.create({
      model:      MARKDOWN_MODEL(),
      max_tokens: 8000,
      temperature: 0,
      messages: [{ role: 'user', content: userContent }],
    }),
    { label: `reconstructMarkdown:${documentId}` }
  );

  const markdown = response.content
    .map(p => (p.type === 'text' ? p.text : ''))
    .join('\n')
    .trim();

  if (!markdown) {
    throw new Error('Claude returned an empty markdown reconstruction.');
  }

  await dbPool.query(
    `UPDATE documents
     SET generated_markdown = $1, updated_at = NOW()
     WHERE id = $2`,
    [markdown, documentId]
  );

  logger.info('[markdownReconstructor] Markdown stored', {
    documentId,
    slideCount:  rows.length,
    charCount:   markdown.length,
  });

  return markdown;
}
