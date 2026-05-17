import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { buildSlideAnalysisPrompt } from '../utils/visual-prompts.js';

// Separate client with longer timeout for vision calls (images take more time to process).
let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.VISUAL_LLM_TIMEOUT_MS || 60_000),
    });
  }
  return _client;
}

const SLIDE_MODEL = () => process.env.VISUAL_SLIDE_MODEL || 'claude-sonnet-4-6';

/**
 * Attempts to parse a JSON object from a raw LLM response string.
 * The model is instructed not to wrap in backticks, but we handle it anyway.
 */
function safeParseSlideJson(raw, slideNumber) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Strip markdown code fences if the model added them despite instructions
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Find first { and last } to handle leading/trailing noise
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Builds a minimal valid structured_json when Claude's response cannot be parsed.
 * This keeps the pipeline running and preserves the warning for audit.
 */
function fallbackSlideJson(slideNumber, warningMessage) {
  return {
    slide_number:      slideNumber,
    title:             null,
    visible_text:      [],
    formulas:          [],
    visual_description: '',
    diagram_relations: [],
    teacher_intent:    '',
    concepts_candidate: [],
    warnings:          [warningMessage],
  };
}

/**
 * Reads an image from disk, encodes it as base64, and calls Claude vision
 * with the slide analysis prompt. Stores the result in document_slides.
 *
 * Never throws: on any failure, inserts a fallback row with the error in warnings.
 */
export async function analyzeSlide(documentId, slideNumber, imagePath) {
  let structuredJson;

  try {
    const imageBuffer = await readFile(imagePath);
    const base64Data  = imageBuffer.toString('base64');

    const response = await withRetry(
      () => getClient().messages.create({
        model:      SLIDE_MODEL(),
        max_tokens: 2000,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type:       'base64',
                media_type: 'image/jpeg',
                data:       base64Data,
              },
            },
            {
              type: 'text',
              text: buildSlideAnalysisPrompt(slideNumber),
            },
          ],
        }],
      }),
      { label: `analyzeSlide:${documentId}:${slideNumber}` }
    );

    const rawText = response.content
      .map(p => (p.type === 'text' ? p.text : ''))
      .join('\n')
      .trim();

    const parsed = safeParseSlideJson(rawText, slideNumber);

    if (parsed) {
      // Ensure slide_number matches what we sent (model might hallucinate it)
      parsed.slide_number = slideNumber;
      structuredJson = parsed;
    } else {
      logger.warn('[slideAnalyzer] Could not parse JSON for slide', {
        documentId, slideNumber, rawPreview: rawText.slice(0, 200),
      });
      structuredJson = fallbackSlideJson(slideNumber, 'claude_parse_error');
    }
  } catch (err) {
    logger.error('[slideAnalyzer] Vision call failed for slide', {
      documentId, slideNumber, error: err.message,
    });
    structuredJson = fallbackSlideJson(slideNumber, `vision_call_error: ${err.message}`);
  }

  const extractedText   = (structuredJson.visible_text || []).join('\n') || null;
  const visualSummary   = structuredJson.visual_description || null;

  await dbPool.query(
    `INSERT INTO document_slides
       (document_id, slide_number, image_path, extracted_text, visual_summary, structured_json)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (document_id, slide_number) DO UPDATE SET
       image_path      = EXCLUDED.image_path,
       extracted_text  = EXCLUDED.extracted_text,
       visual_summary  = EXCLUDED.visual_summary,
       structured_json = EXCLUDED.structured_json`,
    [documentId, slideNumber, imagePath, extractedText, visualSummary, JSON.stringify(structuredJson)]
  );

  logger.info('[slideAnalyzer] Slide stored', {
    documentId,
    slideNumber,
    hasWarnings: (structuredJson.warnings || []).length > 0,
  });

  return structuredJson;
}
