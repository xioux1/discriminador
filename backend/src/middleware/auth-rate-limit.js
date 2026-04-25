/**
 * Sliding-window rate limiter for auth endpoints (/auth/login, /auth/register).
 * Keyed by IP address since these routes are called before authentication.
 *
 * Env vars (all optional):
 *   AUTH_RATE_LIMIT_REQUESTS  – max attempts per window (default: 10)
 *   AUTH_RATE_LIMIT_WINDOW_MS – window in ms (default: 900000 = 15 min)
 */

const MAX_REQUESTS = Number.parseInt(process.env.AUTH_RATE_LIMIT_REQUESTS  || '10', 10);
const WINDOW_MS    = Number.parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000', 10);

// Map<ip, { count: number, windowStart: number }>
const _store = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _store) {
    if (now - entry.windowStart >= WINDOW_MS) _store.delete(key);
  }
}, 5 * 60 * 1000).unref();

export function authRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  const now   = Date.now();
  const key   = String(ip);
  const entry = _store.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    _store.set(key, { count: 1, windowStart: now });
    return next();
  }

  if (entry.count >= MAX_REQUESTS) {
    const retryAfterMs = WINDOW_MS - (now - entry.windowStart);
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({
      error:          'rate_limit_exceeded',
      message:        `Demasiados intentos. Intentá de nuevo en ${Math.ceil(retryAfterMs / 60000)} minutos.`,
      retry_after_ms: retryAfterMs,
    });
  }

  entry.count += 1;
  return next();
}
