import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

export const dbPool = new Pool({
  connectionString:        env.databaseUrl,
  max:                     Number.parseInt(process.env.DB_POOL_MAX               || '10', 10),
  idleTimeoutMillis:       Number.parseInt(process.env.DB_POOL_IDLE_TIMEOUT_MS   || '30000', 10),
  connectionTimeoutMillis: Number.parseInt(process.env.DB_POOL_CONN_TIMEOUT_MS   || '5000', 10),
});

// Surface pool-level errors in app logs instead of swallowing them silently.
dbPool.on('error', (err) => {
  console.error('[db pool] Unexpected idle client error', { message: err.message });
});
