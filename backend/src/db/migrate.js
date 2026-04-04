/**
 * Auto-migration runner.
 * Runs all pending SQL migrations from db/migrations/ in order on startup.
 * Tracks applied migrations in a `schema_migrations` table.
 *
 * Each migration runs in its own independent client connection so that
 * migrations that manage their own BEGIN/COMMIT (like 0003) don't
 * interfere with each other.
 *
 * Graceful handling: migrations that fail with "already exists" errors
 * (manually applied before the auto-runner existed) are marked as done.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

// PostgreSQL error codes meaning "object already exists".
const ALREADY_EXISTS_CODES = new Set([
  '42P07', // duplicate_table
  '42710', // duplicate_object (constraint, index, type…)
  '42701', // duplicate_column
  '42P16', // invalid_table_definition (some constraint variants)
]);

async function run(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

async function markApplied(pool, file) {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
      [file]
    );
  } finally {
    client.release();
  }
}

async function getApplied(pool) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    return new Set(rows.map((r) => r.filename));
  } finally {
    client.release();
  }
}

async function applyOne(pool, file, sql) {
  try {
    await run(pool, sql);
    await markApplied(pool, file);
    console.info(`[migrations] Applied ${file}.`);
  } catch (err) {
    if (ALREADY_EXISTS_CODES.has(err.code)) {
      console.warn(
        `[migrations] ${file} already applied manually (pg ${err.code}), marking as done.`
      );
      await markApplied(pool, file);
    } else {
      throw err;
    }
  }
}

export async function runMigrations(pool) {
  // Ensure tracking table exists (safe to run multiple times).
  await run(pool, `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await getApplied(pool);

  let files;
  try {
    files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    console.warn('[migrations] migrations directory not found, skipping.');
    return;
  }

  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.info('[migrations] All migrations up to date.');
    return;
  }

  for (const file of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    console.info(`[migrations] Applying ${file}...`);
    await applyOne(pool, file, sql);
  }

  console.info(`[migrations] ${pending.length} migration(s) processed.`);
}
