import { createApp } from './app.js';
import { assertRequiredEnv, env } from './config/env.js';

assertRequiredEnv();

const app = createApp();

app.listen(env.port, env.host, () => {
  console.log(`Backend listening on http://${env.host}:${env.port}`);
});
