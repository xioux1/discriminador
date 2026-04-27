import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.CARD_EXTRACTION_LLM_TIMEOUT_MS || 90_000),
    });
  }
  return _client;
}

const VALID_STATUSES = new Set(['ready', 'ambiguous', 'needs_edit', 'rejected']);

const SYSTEM_PROMPT = `Sos un asistente especializado en extraer tarjetas de estudio a partir de texto fuente.

Tu tarea principal es identificar pares pregunta-respuesta que estén EXPLÍCITAMENTE presentes en el texto y convertirlos en tarjetas de estudio.

Tipos de texto que debés procesar:
- Textos con preguntas numeradas seguidas de respuestas (ej: "8.4.2 ¿Qué es X?: Y es Z.")
- Textos con definiciones ("X se define como Y")
- Textos con explicaciones de conceptos ("X ocurre cuando Y")
- Fragmentos con información factual clara

Reglas de extracción:
1. NO inventes información ni uses conocimiento externo.
2. La respuesta debe estar textualmente en el texto fuente; copiala con mínima paráfrasis.
3. Si el texto contiene una pregunta con su respuesta explícita, siempre extraela como tarjeta "ready".
4. Si la información es útil pero incompleta, usá "needs_edit". Si es ambigua, usá "ambiguous".
5. Reservá "rejected" solo para texto que genuinamente no contiene información educativa.
6. Siempre incluí source_excerpt: el fragmento exacto del texto que respalda la tarjeta.
7. Evitá duplicados: si dos preguntas evalúan lo mismo, generá solo una.
8. Respondé ÚNICAMENTE con JSON válido. Sin markdown, sin backticks, sin texto antes o después.

Formato de salida (JSON exacto):
{
  "cards": [
    {
      "question": "pregunta clara y específica",
      "answer": "respuesta concisa extraída del texto",
      "source_excerpt": "fragmento textual exacto del texto fuente",
      "confidence": 0.95,
      "status": "ready"
    }
  ],
  "warnings": []
}

confidence: número entre 0.0 y 1.0 que refleja qué tan claramente el texto respalda la tarjeta.
El campo "notes" es opcional: usalo solo si la tarjeta necesita aclaración para el revisor.`;

function buildUserPrompt(text, subject) {
  const subjectLine = subject ? `Materia: ${subject}\n\n` : '';
  return `${subjectLine}Texto fuente:\n\n${text}`;
}

function parseAndValidateLLMResponse(raw) {
  // Try direct parse
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to extract JSON object from surrounding text / markdown fences
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        logger.warn('[cardExtraction] JSON parse failed after fallback', { raw: raw.slice(0, 300) });
        return { cards: [], warnings: ['LLM devolvió JSON inválido.'] };
      }
    } else {
      logger.warn('[cardExtraction] No JSON object found in response', { raw: raw.slice(0, 300) });
      return { cards: [], warnings: ['LLM no devolvió JSON.'] };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn('[cardExtraction] Unexpected top-level type', { type: typeof parsed });
    return { cards: [], warnings: ['LLM devolvió formato inesperado.'] };
  }

  const rawCards = Array.isArray(parsed.cards) ? parsed.cards : [];
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter(w => typeof w === 'string')
    : [];

  const cards = [];
  for (const c of rawCards) {
    if (!c || typeof c !== 'object') continue;

    const question = typeof c.question === 'string' ? c.question.trim() : '';
    const answer = typeof c.answer === 'string' ? c.answer.trim() : '';
    const sourceExcerpt = typeof c.source_excerpt === 'string' ? c.source_excerpt.trim() : '';
    const confidence =
      typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1
        ? c.confidence
        : 0.5;
    const status = VALID_STATUSES.has(c.status) ? c.status : 'needs_edit';
    const notes = typeof c.notes === 'string' ? c.notes.trim() : undefined;

    if (!question || !answer) {
      warnings.push('Tarjeta descartada por falta de pregunta o respuesta.');
      continue;
    }

    const card = { question, answer, source_excerpt: sourceExcerpt, confidence, status };
    if (notes) card.notes = notes;
    cards.push(card);
  }

  return { cards, warnings };
}

function deduplicateCandidates(cards) {
  const seen = new Set();
  const result = [];
  for (const card of cards) {
    const key = card.question.toLowerCase().replace(/\s+/g, ' ');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(card);
    }
  }
  return result;
}

export async function extractCandidateCardsFromText({ text, subject, document_id }) {
  const trimmedText = typeof text === 'string' ? text.trim() : '';
  if (!trimmedText) {
    const err = new Error('text no puede estar vacío.');
    err.statusCode = 422;
    err.code = 'validation_error';
    throw err;
  }

  const model = process.env.CARD_EXTRACTION_MODEL || 'claude-sonnet-4-6';

  logger.info('[cardExtraction] Calling LLM', { model, textLength: trimmedText.length, subject });

  const client = getClient();
  const message = await client.messages.create({
    model,
    max_tokens: 4000,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(trimmedText, subject) }],
  });

  const rawContent = message.content?.find(b => b.type === 'text')?.text ?? '';
  logger.info('[cardExtraction] Raw response', { length: rawContent.length, preview: rawContent.slice(0, 200) });

  const { cards, warnings } = parseAndValidateLLMResponse(rawContent);
  const deduped = deduplicateCandidates(cards);

  logger.info('[cardExtraction] Done', { cardCount: deduped.length, warnings });

  return { cards: deduped, warnings };
}
