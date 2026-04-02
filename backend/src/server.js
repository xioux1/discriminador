import { createApp } from './app.js';
import { assertRequiredEnv, env } from './config/env.js';

assertRequiredEnv();

const app = createApp();

app.listen(env.port, env.host, () => {
  console.info('Preprocessing rollout', {
    activeVariant: env.enablePreprocessingV2 ? 'v2' : 'legacy',
    enablePreprocessingV2: env.enablePreprocessingV2,
    offlineComparisonAvailable: 'scoreEvaluationOfflineComparison'
  });
  console.log(`Backend listening on http://${env.host}:${env.port}`);
});
