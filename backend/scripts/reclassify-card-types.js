#!/usr/bin/env node
/**
 * Reclassify cards whose card_type may be wrong.
 *
 * All cards created before the fix were stored as 'theoretical_open' even when
 * they contain practical exercises (SQL queries, code, step-by-step derivations).
 * This script uses an LLM to check each 'theoretical_open' card and re-labels it
 * as 'practical_exercise' when appropriate.
 *
 * Usage:
 *   cd backend
 *   node scripts/reclassify-card-types.js            # dry-run (no writes)
 *   node scripts/reclassify-card-types.js --apply    # write changes to DB
 *   node scripts/reclassify-card-types.js --apply --subject "Bases de Datos"
 *   node scripts/reclassify-card-types.js --apply --limit 50
 */

import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const SUBJECT = (() => {
  const idx = args.indexOf('--subject');
  return idx !== -1 ? args[idx + 1] : null;
})();
const LIMIT = (() => {
  const idx = args.indexOf('--limit');
  return idx !== -1 ? Number(args[idx + 1]) : 0; // 0 = no limit
})();
const BATCH = 10; // concurrent LLM calls per round

// ── Setup ─────────────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.RECLASSIFY_MODEL || 'claude-haiku-4-5-20251001';

console.log(`Modo: ${DRY_RUN ? 'DRY-RUN (sin cambios)' : 'APPLY (escribiendo en DB)'}`);
console.log(`Modelo: ${MODEL}`);
if (SUBJECT) console.log(`Filtro de materia: "${SUBJECT}"`);
if (LIMIT)   console.log(`Límite: ${LIMIT} tarjetas`);
console.log();

// ── Fetch cards to inspect ─────────────────────────────────────────────────────
const params = [];
let subjectClause = '';
if (SUBJECT) { params.push(SUBJECT); subjectClause = `AND subject = $${params.length}`; }
let limitClause = '';
if (LIMIT)   { params.push(LIMIT);  limitClause   = `LIMIT $${params.length}`; }

const { rows: cards } = await pool.query(
  `SELECT id, subject, prompt_text, expected_answer_text
   FROM cards
   WHERE card_type = 'theoretical_open'
     AND archived_at IS NULL
     ${subjectClause}
   ORDER BY id
   ${limitClause}`,
  params
);

console.log(`Tarjetas a evaluar: ${cards.length}`);
if (cards.length === 0) { await pool.end(); process.exit(0); }

// ── Classify one card ──────────────────────────────────────────────────────────
async function classify(card) {
  const prompt = `Clasificá esta tarjeta de estudio en una de estas dos categorías:
- "theoretical_open": el alumno debe explicar, definir o describir un concepto (respuesta verbal).
- "practical_exercise": el alumno debe producir algo concreto: código, una query SQL, una derivación algebraica paso a paso, un cálculo numérico con pasos intermedios.

PREGUNTA:
${card.prompt_text.slice(0, 800)}

RESPUESTA ESPERADA:
${card.expected_answer_text.slice(0, 800)}

Respondé únicamente con "theoretical_open" o "practical_exercise", sin explicación.`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 10,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = (msg.content?.[0]?.text ?? '').trim().toLowerCase();
  if (raw.includes('practical_exercise')) return 'practical_exercise';
  if (raw.includes('theoretical_open'))  return 'theoretical_open';
  // Fallback: keep as-is if response is unexpected
  console.warn(`  [!] Respuesta inesperada del LLM para card ${card.id}: "${raw}" — se mantiene theoretical_open`);
  return 'theoretical_open';
}

// ── Process in batches ─────────────────────────────────────────────────────────
let reclassified = 0;
let unchanged    = 0;
let errors       = 0;

for (let i = 0; i < cards.length; i += BATCH) {
  const batch = cards.slice(i, i + BATCH);
  const results = await Promise.allSettled(batch.map(async (card) => {
    const newType = await classify(card);
    return { card, newType };
  }));

  for (const result of results) {
    if (result.status === 'rejected') {
      errors++;
      console.error(`  [error] ${result.reason?.message}`);
      continue;
    }
    const { card, newType } = result.value;
    if (newType === 'theoretical_open') {
      unchanged++;
      continue;
    }
    // newType === 'practical_exercise'
    reclassified++;
    const subjectLabel = card.subject ?? '(sin materia)';
    const preview = card.prompt_text.slice(0, 80).replace(/\n/g, ' ');
    console.log(`  [→ practical_exercise] id=${card.id} [${subjectLabel}] "${preview}"`);
    if (!DRY_RUN) {
      await pool.query(
        `UPDATE cards SET card_type = 'practical_exercise' WHERE id = $1`,
        [card.id]
      );
    }
  }

  const done = Math.min(i + BATCH, cards.length);
  process.stdout.write(`\rProgreso: ${done}/${cards.length}`);
}

console.log('\n');
console.log('─── Resumen ───────────────────────────────────────────');
console.log(`  Evaluadas:        ${cards.length}`);
console.log(`  Sin cambio:       ${unchanged}`);
console.log(`  → practical_exercise: ${reclassified}${DRY_RUN ? ' (DRY-RUN, no se escribió)' : ''}`);
if (errors > 0) console.log(`  Errores:          ${errors}`);
console.log('───────────────────────────────────────────────────────');

if (DRY_RUN && reclassified > 0) {
  console.log('\nRe-ejecutá con --apply para escribir los cambios.');
}

await pool.end();
