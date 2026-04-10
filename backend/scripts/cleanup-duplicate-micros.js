#!/usr/bin/env node
/**
 * One-time cleanup: archive extra active micro_cards, keeping only the newest
 * per parent_card_id. Cards that already have 0 or 1 active micro are untouched.
 *
 * Usage:
 *   cd backend && node scripts/cleanup-duplicate-micros.js
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const { rows: dupes } = await pool.query(`
  SELECT parent_card_id, COUNT(*) AS cnt
  FROM micro_cards
  WHERE status = 'active'
  GROUP BY parent_card_id
  HAVING COUNT(*) > 1
  ORDER BY parent_card_id
`);

if (dupes.length === 0) {
  console.log('No hay micros duplicadas. Nada que hacer.');
  await pool.end();
  process.exit(0);
}

console.log(`Tarjetas con micros duplicadas: ${dupes.length}`);
for (const { parent_card_id, cnt } of dupes) {
  console.log(`  card_id=${parent_card_id}  activas=${cnt}`);
}

// Archive all but the newest active micro per parent card
const { rowCount } = await pool.query(`
  UPDATE micro_cards
  SET status = 'archived', updated_at = now()
  WHERE status = 'active'
    AND id NOT IN (
      SELECT DISTINCT ON (parent_card_id) id
      FROM micro_cards
      WHERE status = 'active'
      ORDER BY parent_card_id, created_at DESC
    )
`);

console.log(`\nArchivadas: ${rowCount} micro(s) duplicada(s).`);

// Verify
const { rows: remaining } = await pool.query(`
  SELECT parent_card_id, COUNT(*) AS cnt
  FROM micro_cards
  WHERE status = 'active'
  GROUP BY parent_card_id
  HAVING COUNT(*) > 1
`);

if (remaining.length === 0) {
  console.log('Verificacion OK: ninguna tarjeta tiene mas de 1 micro activa.');
} else {
  console.error('ERROR: aun quedan duplicadas:', remaining);
}

await pool.end();
