#!/usr/bin/env node
/**
 * One-time fix: populate micro_cards.subject from their parent card's subject.
 * Only touches rows where subject IS NULL.
 *
 * Usage:
 *   cd backend && node scripts/fix-micro-cards-subject.js
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Count affected rows first
const { rows: preview } = await pool.query(`
  SELECT COUNT(*) AS cnt
  FROM micro_cards mc
  JOIN cards c ON c.id = mc.parent_card_id
  WHERE mc.subject IS NULL
    AND c.subject IS NOT NULL
`);

const count = Number(preview[0].cnt);
if (count === 0) {
  console.log('No hay micro_cards sin materia que tengan una tarjeta padre con materia. Nada que hacer.');
  await pool.end();
  process.exit(0);
}

console.log(`Micro-tarjetas sin materia a corregir: ${count}`);

const { rowCount } = await pool.query(`
  UPDATE micro_cards mc
  SET subject = c.subject, updated_at = now()
  FROM cards c
  WHERE c.id = mc.parent_card_id
    AND mc.subject IS NULL
    AND c.subject IS NOT NULL
`);

console.log(`Actualizadas: ${rowCount} micro-tarjeta(s).`);

// Remaining nulls (parent also has no subject — nothing we can do)
const { rows: remaining } = await pool.query(`
  SELECT COUNT(*) AS cnt FROM micro_cards WHERE subject IS NULL
`);
if (Number(remaining[0].cnt) > 0) {
  console.log(`Quedan ${remaining[0].cnt} micro(s) sin materia cuyo padre tampoco tiene materia asignada.`);
}

await pool.end();
