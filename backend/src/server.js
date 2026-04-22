import { createApp } from './app.js';
import { assertRequiredEnv, env } from './config/env.js';
import { dbPool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { startBot } from './services/discord-bot.js';
import { checkAndNudge } from './services/study-nudge.js';
import cron from 'node-cron';

assertRequiredEnv();

await runMigrations(dbPool);

// Start Discord bot (no-op if DISCORD_BOT_TOKEN is unset)
startBot().catch((err) => console.error('[discord-bot] startup error:', err.message));

// Daily nudge cron — 9 AM Argentina time (UTC-3 = 12:00 UTC)
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

app.listen(env.port, env.host, () => {
  console.info('Preprocessing rollout', {
    activeVariant: env.enablePreprocessingV2 ? 'v2' : 'legacy',
    enablePreprocessingV2: env.enablePreprocessingV2,
    offlineComparisonAvailable: 'scoreEvaluationOfflineComparison'
  });
  console.log(`Backend listening on http://${env.host}:${env.port}`);
});
