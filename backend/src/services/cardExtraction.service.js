import Anthropic from '@anthropic-ai/sdk';

let _client = null;
function getClient() {
  if (!_client) {
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.CARD_EXTRACTION_LLM_TIMEOUT_MS || 60_000),
    });
  }
  return _client;
}

const VALID_STATUSES = new Set(['ready', 'ambiguous', 'needs_edit', 'rejected']);

const SYSTEM_PROMPT = `Sos un asistente especializado en extraer tarjetas de estudio a partir de texto fuente.

Reglas estrictas:
1. NO inventes información. NO uses conocimiento externo.
2. Solo extrae tarjetas directamente soportadas por el texto provisto.
3. NO mejores ni expandas la respuesta más allá de lo que dice el texto.
4. Preferí preguntas de respuesta corta y directa.
5. Siempre incluí el fragmento fuente (source_excerpt) que justifica la tarjeta.
6. Si una tarjeta es ambigua o incompleta según el texto, marcala como "ambiguous" o "needs_edit".
7. Si el texto no permite formular una tarjeta confiable, marcala como "rejected".
8. Evitá duplicados: si dos preguntas evalúan exactamente lo mismo, generá solo una.
9. No generes más tarjetas de las que el texto genuinamente soporta.
10. Respondé ÚNICAMENTE con JSON válido. Sin markdown, sin texto adicional, sin backticks.

Formato exacto de salida:
{
  "cards": [
    {
      "question": "pregunta clara y específica",
      "answer": "respuesta concisa basada solo en el texto",
      "source_excerpt": "fragmento textual del texto fuente que justifica la tarjeta",
      "confidence": 0.95,
      "status": "ready",
      "notes": "opcional: observación si la tarjeta necesita revisión"
    }
  ],
  "warnings": ["aviso global si corresponde"]
}

Valores válidos de status:
- "ready": tarjeta clara, bien soportada, lista para usar
- "ambiguous": el texto no define claramente la respuesta
- "needs_edit": la tarjeta es útil pero requiere revisión humana
- "rejected": el texto no provee información suficiente para la tarjeta

confidence debe ser un número entre 0.0 y 1.0.`;

function buildUserPrompt(text, subject) {
  const subjectLine = subject ? `Materia: ${subject}\n\n` : '';
  return `${subjectLine}Texto fuente:\n\n${text}`;
}

function parseAndValidateLLMResponse(raw) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        return { cards: [], warnings: ['LLM devolvió JSON inválido.'] };
      }
    } else {
      return { cards: [], warnings: ['LLM no devolvió JSON.'] };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { cards: [], warnings: ['LLM devolvió formato inesperado.'] };
  }

  const rawCards = Array.isArray(parsed.cards) ? parsed.cards : [];
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter(w => typeof w === 'string') : [];

  const cards = [];
  for (const c of rawCards) {
    if (!c || typeof c !== 'object') continue;

    const question = typeof c.question === 'string' ? c.question.trim() : '';
    const answer = typeof c.answer === 'string' ? c.answer.trim() : '';
    const sourceExcerpt = typeof c.source_excerpt === 'string' ? c.source_excerpt.trim() : '';
    const confidence = typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1 ? c.confidence : 0.5;
    const status = VALID_STATUSES.has(c.status) ? c.status : 'needs_edit';
    const notes = typeof c.notes === 'string' ? c.notes.trim() : undefined;

    if (!question || !answer) {
      warnings.push(`Tarjeta descartada por falta de pregunta o respuesta.`);
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

  const model = process.env.CARD_EXTRACTION_MODEL || 'claude-haiku-4-5-20251001';

  const client = getClient();
  const message = await client.messages.create({
    model,
    max_tokens: 4000,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(trimmedText, subject) }],
  });

  const rawContent = message.content?.find(b => b.type === 'text')?.text ?? '';
  const { cards, warnings } = parseAndValidateLLMResponse(rawContent);
  const deduped = deduplicateCandidates(cards);

  return { cards: deduped, warnings };
}
