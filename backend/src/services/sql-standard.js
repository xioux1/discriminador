import Anthropic from '@anthropic-ai/sdk';
import { KEYWORD_SET } from './plsql-parser.js';

const SQL_MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let raw = fence ? fence[1] : text;
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s !== -1 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Detects if a text contains SQL/PL-SQL code using keyword heuristic.
export function looksLikeSqlAnswer(text) {
  if (!text) return false;
  const upper = text.toUpperCase();
  const forceKeywords = ['BEGIN', 'DECLARE', 'CREATE OR REPLACE', 'CREATE PROCEDURE', 'CREATE FUNCTION'];
  if (forceKeywords.some(kw => upper.includes(kw))) return true;
  let hits = 0;
  for (const kw of KEYWORD_SET) {
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(upper)) hits++;
    if (hits >= 3) return true;
  }
  return false;
}

// Extracts cátedra coding rules from professor transcripts and code blocks.
// Returns { rules: RuleObject[], summary: string }
export async function extractStandardFromMaterial({ transcriptText, codeBlocks, subject }) {
  const material = [
    transcriptText ? `TRANSCRIPCIÓN:\n${transcriptText}` : '',
    codeBlocks ? `BLOQUES DE CÓDIGO:\n${codeBlocks}` : '',
  ].filter(Boolean).join('\n\n---\n\n');

  const response = await getClient().messages.create({
    model: SQL_MODEL,
    max_tokens: 2000,
    temperature: 0,
    system: `Sos un extractor de estándares de codificación SQL/PL-SQL de cátedra universitaria.
Tu tarea: analizar el material de clase (transcripciones y código de ejemplo) e identificar las reglas de estilo, convención y estructura que el profesor exige.

Buscá:
- Convenciones de nombres (variables, cursores, procedimientos, parámetros)
- Formato y estructura (dónde poner el BEGIN, END, sangría, etc.)
- Patrones obligatorios (ej: siempre usar cursor FOR, siempre cerrar con COMMIT)
- Patrones prohibidos (ej: nunca usar SELECT *, no usar cursores implícitos cuando el profe quiere explícitos)
- Frases del profesor como "siempre", "nunca", "tienen que", "pierden puntos si", "la cátedra exige"

Para cada regla extraída, asignale una categoría: "naming" | "formatting" | "style" | "structure" | "forbidden"
y severidad: "error" (se descuenta puntos) | "warning" (es preferible)

RESPONDÉ SOLO JSON con este schema exacto:
{
  "rules": [
    {
      "id": 1,
      "category": "naming",
      "description": "descripción clara de la regla en español",
      "pattern_hint": "ejemplo correcto e incorrecto (opcional)",
      "severity": "error",
      "source_quote": "frase textual del material que originó esta regla (si la hay)"
    }
  ],
  "summary": "resumen de 2-3 oraciones del estilo de codificación de la cátedra"
}`,
    messages: [{ role: 'user', content: `Materia: ${subject}\n\n${material}` }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const result = extractJson(text);
  if (!result || !Array.isArray(result.rules)) {
    return { rules: [], summary: 'No se pudieron extraer reglas del material.' };
  }
  return result;
}

// Validates a card's expected_answer_text against the cátedra standard rules.
// Returns { compliant: boolean, violations: ViolationObject[] }
export async function validateCardAgainstStandard({ expectedAnswerText, standardRules }) {
  if (!standardRules || standardRules.length === 0) {
    return { compliant: true, violations: [] };
  }

  const rulesText = standardRules.map(
    (r, i) => `REGLA ${i + 1} [${r.severity || 'warning'}] (${r.category}): ${r.description}${r.pattern_hint ? `\nEjemplo: ${r.pattern_hint}` : ''}`
  ).join('\n\n');

  const response = await getClient().messages.create({
    model: SQL_MODEL,
    max_tokens: 800,
    temperature: 0,
    system: `Sos un validador de estilo SQL/PL-SQL. Recibís un conjunto de reglas de la cátedra y un bloque de código de estudiante.
Tu tarea: identificar qué reglas NO se cumplen en el código, citando el fragmento exacto que las viola.

Respondé SOLO JSON:
{
  "compliant": true | false,
  "violations": [
    {
      "rule_number": 1,
      "description": "descripción de la regla incumplida",
      "severity": "error" | "warning",
      "quote": "fragmento exacto del código que viola la regla"
    }
  ]
}
Si no hay violaciones, "violations" debe ser [].`,
    messages: [{
      role: 'user',
      content: `REGLAS DE LA CÁTEDRA:\n${rulesText}\n\n---\n\nCÓDIGO A VALIDAR:\n${expectedAnswerText}`,
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const result = extractJson(text);
  if (!result) return { compliant: true, violations: [] };
  return {
    compliant: Boolean(result.compliant),
    violations: Array.isArray(result.violations) ? result.violations : [],
  };
}
