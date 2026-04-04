/**
 * Auto-migration runner.
 * Runs all pending SQL migrations from db/migrations/ in order on startup.
 * Tracks applied migrations in a `schema_migrations` table.
 *
 * Graceful handling: if a migration fails with "already exists" errors
 * (e.g. migrations that were manually applied before the auto-runner existed),
 * it is marked as applied and execution continues.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

// PostgreSQL error codes that mean "object already exists".
// We treat these as "migration was already applied manually".
const ALREADY_EXISTS_CODES = new Set([
  '42P07', // duplicate_table
  '42710', // duplicate_object (constraint, index name, type, …)
  '42701', // duplicate_column
  '42P16', // invalid_table_definition (some constraint variants)
]);

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getApplied(client) {
  const { rows } = await client.query(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  return new Set(rows.map((r) => r.filename));
}

async function applyOne(client, file, sql) {
  // SAVEPOINT lets us recover from errors without aborting the outer transaction.
  await client.query('SAVEPOINT before_migration');
  try {
    await client.query(sql);
    await client.query('RELEASE SAVEPOINT before_migration');
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [file]
    );
    console.info(`[migrations] Applied ${file}.`);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT before_migration');
    await client.query('RELEASE SAVEPOINT before_migration');

    if (ALREADY_EXISTS_CODES.has(err.code)) {
      // Migration was run manually before the auto-runner existed — mark it done.
      console.warn(
        `[migrations] ${file} already applied manually (pg ${err.code}), marking as done.`
      );
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file]
      );
    } else {
      throw err;
    }
  }
}

export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);

    const applied = await getApplied(client);

    let files;
    try {
      files = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch {
      console.warn('[migrations] migrations directory not found, skipping.');
      await client.query('COMMIT');
      return;
    }

    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.info('[migrations] All migrations up to date.');
      await client.query('COMMIT');
      return;
    }

    for (const file of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      console.info(`[migrations] Applying ${file}...`);
      await applyOne(client, file, sql);
    }

    await client.query('COMMIT');
    console.info(`[migrations] ${pending.length} migration(s) processed.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrations] Migration failed, rolled back.', { message: err.message });
    throw err;
  } finally {
    client.release();
  }
}
