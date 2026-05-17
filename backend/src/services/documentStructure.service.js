import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const STRUCTURE_MODEL    = () => process.env.DOCUMENT_STRUCTURE_MODEL || 'claude-haiku-4-5-20251001';
const STRUCTURE_TIMEOUT  = () => Number(process.env.DOCUMENT_STRUCTURE_TIMEOUT_MS || 30_000);
const MAX_INPUT_WORDS    = 3000;

const VALID_STRUCTURE_TYPES = new Set([
  'process_stages',
  'taxonomy',
  'comparison',
  'concept_lesson',
  'case_study',
  'mixed',
]);

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({
      apiKey:   process.env.ANTHROPIC_API_KEY,
      timeout:  STRUCTURE_TIMEOUT(),
    });
  }
  return _client;
}

function truncateToWords(text, maxWords) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '\n[... contenido truncado ...]';
}

const DETECTION_PROMPT = `Analizá el siguiente material de estudio y determiná su estructura organizativa.

Respondé SOLO con un JSON object. Sin texto adicional, sin markdown, sin backticks.

Formato exacto:
{
  "structure_type": "<uno de: process_stages | taxonomy | comparison | concept_lesson | case_study | mixed>",
  "main_topic": "<tema principal del documento en 3-8 palabras>",
  "primary_axis": "<qué eje organiza el contenido: etapas cronológicas | jerarquía conceptual | dimensiones comparativas | secuencia pedagógica | narrativa de caso | múltiples ejes>",
  "ordered_sections": [
    {
      "name": "<nombre canónico de la sección/etapa>",
      "order": <número entero 1-based>,
      "aliases": ["<sinónimos o abreviaciones>"],
      "description": "<qué cubre esta sección en una oración>"
    }
  ],
  "secondary_axes": ["<ejes secundarios si los hay>"]
}

Definiciones:
- process_stages: el documento describe un proceso con etapas secuenciales (metodologías, ciclos de vida, fases de proyecto)
- taxonomy: organiza conceptos en jerarquías o clasificaciones (tipos, categorías, subtipos)
- comparison: contrasta múltiples entidades o enfoques en varias dimensiones
- concept_lesson: explica conceptos teóricos sin un eje organizativo dominante
- case_study: narra un caso o ejemplo real con análisis
- mixed: combina varios de los anteriores sin un eje dominante

Para process_stages: ordered_sections debe listar todas las etapas en orden.
Para otros tipos: ordered_sections puede estar vacío ([]).

Material de estudio:
`;

/**
 * Validates a raw parsed object against the expected schema.
 * Returns a normalized object or null if invalid.
 * Exported for testing.
 */
export function validateDocumentStructure(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const structureType = raw.structure_type;
  if (!VALID_STRUCTURE_TYPES.has(structureType)) return null;

  const orderedSections = Array.isArray(raw.ordered_sections)
    ? raw.ordered_sections.map((s, i) => ({
        name:        String(s.name        || ''),
        order:       Number.isInteger(s.order) ? s.order : i + 1,
        aliases:     Array.isArray(s.aliases) ? s.aliases.map(String) : [],
        description: String(s.description || ''),
      })).filter(s => s.name)
    : [];

  return {
    structure_type:  structureType,
    main_topic:      String(raw.main_topic      || ''),
    primary_axis:    String(raw.primary_axis    || ''),
    ordered_sections: orderedSections,
    secondary_axes:  Array.isArray(raw.secondary_axes)
      ? raw.secondary_axes.map(String)
      : [],
  };
}

/**
 * Calls Haiku to detect the structure of a document's content.
 * Fetches generated_markdown (preferred) or text_content as fallback.
 * Persists the result to documents.document_structure_json.
 * Returns the validated structure object, or null on any failure.
 */
export async function detectDocumentStructure(documentId) {
  let docRow;
  try {
    const { rows } = await dbPool.query(
      `SELECT id, generated_markdown, text_content
       FROM documents
       WHERE id = $1`,
      [documentId]
    );
    if (!rows.length) {
      logger.warn('[documentStructure] Document not found', { documentId });
      return null;
    }
    docRow = rows[0];
  } catch (err) {
    logger.error('[documentStructure] DB fetch failed', { documentId, error: err.message });
    return null;
  }

  const rawText = docRow.generated_markdown || docRow.text_content || '';
  if (!rawText.trim()) {
    logger.warn('[documentStructure] No text content available', { documentId });
    return null;
  }

  const truncated = truncateToWords(rawText, MAX_INPUT_WORDS);
  const userContent = DETECTION_PROMPT + truncated;

  let rawResponse;
  try {
    const response = await withRetry(
      () => getClient().messages.create({
        model:       STRUCTURE_MODEL(),
        max_tokens:  512,
        temperature: 0,
        messages: [{ role: 'user', content: userContent }],
      }),
      { label: `detectDocumentStructure:${documentId}` }
    );

    rawResponse = response.content
      .map(p => (p.type === 'text' ? p.text : ''))
      .join('\n')
      .trim();
  } catch (err) {
    logger.error('[documentStructure] LLM call failed', { documentId, error: err.message });
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    logger.warn('[documentStructure] LLM returned invalid JSON', {
      documentId,
      preview: rawResponse.slice(0, 200),
    });
    return null;
  }

  const structure = validateDocumentStructure(parsed);
  if (!structure) {
    logger.warn('[documentStructure] Invalid structure detected', {
      documentId,
      structure_type: parsed?.structure_type,
    });
    return null;
  }

  try {
    await dbPool.query(
      `UPDATE documents SET document_structure_json = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(structure), documentId]
    );
  } catch (err) {
    logger.error('[documentStructure] DB persist failed (non-fatal)', {
      documentId, error: err.message,
    });
  }

  logger.info('[documentStructure] Structure detected', {
    documentId,
    structure_type:   structure.structure_type,
    main_topic:       structure.main_topic,
    section_count:    structure.ordered_sections.length,
  });

  return structure;
}
