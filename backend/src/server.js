import { createApp } from './app.js';
import { assertRequiredEnv, env } from './config/env.js';
import { dbPool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
// import { startBot } from './services/discord-bot.js';
import { checkAndNudge } from './services/study-nudge.js';
import { logger } from './utils/logger.js';
import cron from 'node-cron';

assertRequiredEnv();

await runMigrations(dbPool);

// Discord bot disabled — nudges go to in-app chat instead
// startBot().catch((err) => console.error('[discord-bot] startup error:', err.message));

// Daily nudge cron — 9 AM Argentina time, writes to bot_conversations (in-app)
cron.schedule('0 12 * * *', async () => {
  try {
    const usersRes = await dbPool.query('SELECT id FROM users');
    for (const row of usersRes.rows) {
      await checkAndNudge(row.id);
    }
  } catch (err) {
    console.error('[cron] daily nudge error:', err.message);
  }
}, { timezone: 'America/Argentina/Buenos_Aires' });

const app = createApp();

const server = app.listen(env.port, env.host, () => {
  logger.info(`Backend listening on http://${env.host}:${env.port}`, {
    activeVariant: env.enablePreprocessingV2 ? 'v2' : 'legacy',
    enablePreprocessingV2: env.enablePreprocessingV2,
  });
});

async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    try {
      await dbPool.end();
      logger.info('DB pool closed');
    } catch (err) {
      logger.error('Error closing DB pool', { message: err.message });
    }
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
