import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger.js';

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.CARD_EXTRACTION_LLM_TIMEOUT_MS || 120_000),
    });
  }
  return _client;
}

const VALID_STATUSES = new Set(['ready', 'ambiguous', 'needs_edit', 'rejected']);

// Maximum input characters sent to the LLM. Larger texts are truncated with a warning.
const MAX_INPUT_CHARS = 30_000;

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

// Strip markdown code fences that Sonnet sometimes adds despite instructions.
function stripFences(raw) {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

// Brace-matching extractor: finds each complete card object even when the
// outer JSON array is truncated (max_tokens hit mid-response).
function extractCardObjectsFromText(text) {
  const marker = text.indexOf('"cards"');
  if (marker === -1) return [];
  const bracketPos = text.indexOf('[', marker);
  if (bracketPos === -1) return [];

  const objects = [];
  let pos = bracketPos + 1;

  while (pos < text.length) {
    const objStart = text.indexOf('{', pos);
    if (objStart === -1) break;

    let depth = 0;
    let objEnd = -1;
    for (let i = objStart; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { objEnd = i; break; }
      }
    }

    if (objEnd === -1) break; // truncated — stop

    try {
      const obj = JSON.parse(text.slice(objStart, objEnd + 1));
      if (obj && typeof obj === 'object') objects.push(obj);
    } catch { /* skip malformed object */ }

    pos = objEnd + 1;
  }

  return objects;
}

function normalizeCard(c, warnings) {
  if (!c || typeof c !== 'object') return null;

  const question = typeof c.question === 'string' ? c.question.trim() : '';
  const answer   = typeof c.answer   === 'string' ? c.answer.trim()   : '';

  if (!question || !answer) {
    warnings.push('Tarjeta descartada por falta de pregunta o respuesta.');
    return null;
  }

  const sourceExcerpt = typeof c.source_excerpt === 'string' ? c.source_excerpt.trim() : '';
  const confidence =
    typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1
      ? c.confidence
      : 0.5;
  const status = VALID_STATUSES.has(c.status) ? c.status : 'needs_edit';
  const notes  = typeof c.notes === 'string' ? c.notes.trim() : undefined;

  const card = { question, answer, source_excerpt: sourceExcerpt, confidence, status };
  if (notes) card.notes = notes;
  return card;
}

function parseAndValidateLLMResponse(raw) {
  const stripped = stripFences(raw);
  const warnings = [];

  // Stage 1: direct parse on fence-stripped content.
  let parsed = null;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Stage 2: extract the outermost { … } block (handles extra text around JSON).
    const start = stripped.indexOf('{');
    const end   = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch { /* continue */ }
    }
  }

  // Stages 1-2 succeeded.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const rawCards = Array.isArray(parsed.cards) ? parsed.cards : [];
    if (Array.isArray(parsed.warnings)) {
      parsed.warnings.filter(w => typeof w === 'string').forEach(w => warnings.push(w));
    }
    const cards = rawCards.map(c => normalizeCard(c, warnings)).filter(Boolean);
    return { cards, warnings };
  }

  // Stage 3: brace-matching recovery for truncated JSON.
  logger.warn('[cardExtraction] Full JSON parse failed — attempting brace-match recovery', {
    preview: stripped.slice(0, 200),
  });

  const recovered = extractCardObjectsFromText(stripped);
  if (recovered.length > 0) {
    warnings.push('Respuesta truncada por el modelo: se recuperaron las tarjetas completas.');
    const cards = recovered.map(c => normalizeCard(c, warnings)).filter(Boolean);
    return { cards, warnings };
  }

  logger.warn('[cardExtraction] Brace-match recovery found no cards', { preview: stripped.slice(0, 300) });
  return { cards: [], warnings: ['LLM devolvió JSON inválido o vacío.'] };
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

  const extraWarnings = [];
  let inputText = trimmedText;
  if (trimmedText.length > MAX_INPUT_CHARS) {
    inputText = trimmedText.slice(0, MAX_INPUT_CHARS);
    extraWarnings.push(`El texto fue truncado a ${MAX_INPUT_CHARS} caracteres para el procesamiento.`);
  }

  const model = process.env.CARD_EXTRACTION_MODEL || 'claude-sonnet-4-6';

  logger.info('[cardExtraction] Calling LLM', { model, textLength: inputText.length, subject });

  const client = getClient();
  const message = await client.messages.create({
    model,
    max_tokens: 8192,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(inputText, subject) }],
  });

  const rawContent = message.content?.find(b => b.type === 'text')?.text ?? '';
  const stopReason = message.stop_reason;

  logger.info('[cardExtraction] Raw response', {
    length: rawContent.length,
    stop_reason: stopReason,
    preview: rawContent.slice(0, 200),
  });

  if (stopReason === 'max_tokens') {
    extraWarnings.push('El modelo alcanzó el límite de tokens: pueden faltar tarjetas del final del texto.');
  }

  const { cards, warnings } = parseAndValidateLLMResponse(rawContent);
  const deduped = deduplicateCandidates(cards);
  const allWarnings = [...extraWarnings, ...warnings];

  logger.info('[cardExtraction] Done', { cardCount: deduped.length, warnings: allWarnings });

  return { cards: deduped, warnings: allWarnings };
}
