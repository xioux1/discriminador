#!/usr/bin/env node
/**
 * Minimal migration runner.
 * Usage: node scripts/migrate.js <path-to-migration.sql>
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const sqlPath = process.argv[2];
if (!sqlPath) {
  console.error('Usage: node scripts/migrate.js <path-to-migration.sql>');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const sql = await readFile(resolve(sqlPath), 'utf8');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(sql);
  console.log('Migration applied successfully.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
