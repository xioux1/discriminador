import { logger } from '../utils/logger.js';

export function notFoundHandler(req, res, next) {
  if (res.headersSent) {
    return next();
  }

  return res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} does not exist.`
  });
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const status = err.statusCode || 500;
  const message = status >= 500 ? 'Internal Server Error' : err.message;

  if (status >= 500) {
    logger.error('Unhandled server error', {
      status,
      message: err.message,
      stack: err.stack,
      path: req.originalUrl,
      method: req.method,
    });
  }

  return res.status(status).json({
    error: status >= 500 ? 'Server Error' : 'Request Error',
    message
  });
}
