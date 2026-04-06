import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes/index.js';
import authRouter from './routes/auth.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(currentDir, '../../ui/main');

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(uiDir));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(uiDir, 'index.html'));
  });

  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Invalid JSON payload or unsupported Content-Type.',
        details: [{ field: 'body', issue: 'Malformed JSON' }]
      });
    }
    return next(err);
  });

  // Public routes (no auth)
  app.use(authRouter);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // All other routes require authentication
  app.use(requireAuth);
  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
