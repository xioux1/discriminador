import Anthropic from '@anthropic-ai/sdk';
import { KEYWORD_SET } from './plsql-parser.js';

const SQL_MODEL = 'claude-haiku-4-5-20251001';
const VALIDATE_MODEL = 'claude-sonnet-4-6';

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
    max_tokens: 4000,
    temperature: 0,
    system: `Sos un extractor de estándares de codificación SQL/PL-SQL de cátedra universitaria.
Tu tarea: analizar el material (transcripciones, código de ejemplo, o ambos) e identificar las reglas de estilo, convención y estructura que el profesor exige.

FUENTES DE REGLAS — usá ambas cuando estén disponibles:
1. Directivas explícitas del profesor: frases como "siempre", "nunca", "tienen que", "pierden puntos si", "la cátedra exige", "se espera que", "es obligatorio".
2. Patrones implícitos en el código de ejemplo: si el código muestra un estilo consistente, ese ES el estándar esperado. Inferí las convenciones del código mismo.

BUSCÁ SIEMPRE (aunque sea solo código sin comentarios del profesor):
- Convenciones de nombres: prefijos de variables (ej: V_, P_, C_, L_), nombres de cursores, procedimientos, funciones, parámetros
- Formato y estructura: indentación, ubicación de DECLARE/BEGIN/END, estilo de END (END loop_name, END IF, etc.)
- Patrones de cursores: FOR implícito vs explícito, apertura/cierre manual, fetch loops
- Manejo de excepciones: bloques EXCEPTION, WHEN OTHERS, mensajes de error
- Manejo de transacciones: COMMIT, ROLLBACK, SAVEPOINT
- Patrones obligatorios visibles en el código (ej: siempre usar DBMS_OUTPUT, siempre verificar %ROWCOUNT)
- Patrones prohibidos evidentes (ej: SELECT * sin alias, cursores implícitos si el código usa siempre explícitos)

IMPORTANTE: Si el material es solo código sin texto del profesor, extraé al menos las convenciones de nombrado y estructura que se ven en el código. Un código de ejemplo enseña el estándar esperado.

Para cada regla, asignale una categoría: "naming" | "formatting" | "style" | "structure" | "forbidden"
y severidad: "error" (se descuenta puntos) | "warning" (es preferible)

RESPONDÉ SOLO JSON, sin texto adicional antes ni después, con este schema exacto:
{
  "rules": [
    {
      "id": 1,
      "category": "naming",
      "description": "descripción clara de la regla en español",
      "pattern_hint": "ejemplo correcto / incorrecto (opcional)",
      "severity": "error",
      "source_quote": "fragmento del material que muestra esta convención (si existe)"
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
    model: VALIDATE_MODEL,
    max_tokens: 2000,
    temperature: 0,
    system: `Sos un validador experto de estilo SQL/PL-SQL para una cátedra universitaria.

PASO 1 — Identificá el tipo de objeto SQL en el código:
PROCEDIMIENTO (CREATE OR REPLACE PROCEDURE / IS ... BEGIN ... END), FUNCIÓN (CREATE OR REPLACE FUNCTION / RETURN), BLOQUE ANÓNIMO (DECLARE ... BEGIN ... END sin CREATE), CURSOR explícito, TRIGGER, o combinación.

PASO 2 — Aplicá SOLO las reglas que corresponden al tipo de objeto detectado:
- Reglas de naming para PROCEDIMIENTOS → solo si el código define un procedimiento
- Reglas de naming para FUNCIONES → solo si el código define una función
- Reglas de naming para parámetros → aplican a procedimientos y funciones con parámetros
- Reglas de naming para variables locales → aplican a cualquier bloque con DECLARE
- Reglas de estructura/formato → aplican siempre
- Reglas sobre cursores → solo si el código usa cursores
- Reglas sobre excepciones → solo si el código tiene bloque EXCEPTION o debería tenerlo

PASO 3 — Una regla NO aplica si el objeto analizado no es del tipo al que la regla se refiere.
Ejemplos de NO-aplica:
  • Regla "procedimientos deben usar prefijo pro_" → no aplica a funciones ni bloques anónimos
  • Regla "funciones deben usar prefijo f_" → no aplica a procedimientos ni bloques anónimos
  • Regla "parámetros OUT deben tener prefijo" → no aplica si no hay parámetros OUT

PASO 4 — Solo reportá violaciones REALES Y CONCRETAS. Si una regla NO aplica al tipo de objeto, no la listés como violación. Dudas → no reportar.

Respondé SOLO JSON, sin texto adicional:
{
  "object_type": "tipo detectado (ej: FUNCIÓN, PROCEDIMIENTO, BLOQUE ANÓNIMO)",
  "compliant": true | false,
  "violations": [
    {
      "rule_number": 1,
      "description": "descripción concreta de qué viola y por qué aplica a este tipo de objeto",
      "severity": "error" | "warning",
      "quote": "fragmento exacto del código que viola la regla"
    }
  ]
}
Si no hay violaciones reales, "violations" debe ser [] y "compliant" debe ser true.`,
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
