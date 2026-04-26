import { logger } from './logger.js';

const isRateLimit = err =>
  err?.status === 429 ||
  err?.error?.error?.type === 'rate_limit_error' ||
  (typeof err?.message === 'string' && err.message.includes('rate_limit_error'));

export async function withRetry(fn, { maxRetries = 6, baseDelayMs = 2000, label = 'withRetry' } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimit(err) || attempt === maxRetries) throw err;
      const jitter = 0.75 + Math.random() * 0.5;
      const delay  = Math.round(baseDelayMs * Math.pow(2, attempt) * jitter);
      logger.warn(`[${label}] Rate limited (429), retrying`, { attempt, delayMs: delay });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
