import express from 'express';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Invalid JSON payload or unsupported Content-Type.',
        details: [
          {
            field: 'body',
            issue: 'Malformed JSON'
          }
        ]
      });
    }

    return next(err);
  });

  app.use(routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
