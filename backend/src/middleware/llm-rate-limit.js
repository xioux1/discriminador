/**
 * In-process sliding-window rate limiter for LLM endpoints.
 * Keyed by user ID (always populated since requireAuth runs first).
 * No external dependency — uses the same Map+TTL pattern as llm-judge.js.
 *
 * Env vars (all optional, sensible defaults):
 *   LLM_RATE_LIMIT_REQUESTS  – max requests per window (default: 30)
 *   LLM_RATE_LIMIT_WINDOW_MS – window in ms             (default: 60000 = 1 min)
 */

const MAX_REQUESTS = Number.parseInt(process.env.LLM_RATE_LIMIT_REQUESTS  || '30', 10);
const WINDOW_MS    = Number.parseInt(process.env.LLM_RATE_LIMIT_WINDOW_MS || '60000', 10);

// Map<userId, { count: number, windowStart: number }>
const _store = new Map();

// Prune stale entries every 5 minutes to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _store) {
    if (now - entry.windowStart >= WINDOW_MS) _store.delete(key);
  }
}, 5 * 60 * 1000).unref();

export function llmRateLimit(req, res, next) {
  const userId = req.user?.id;
  // Fail open: if for any reason there's no user, let requireAuth handle it.
  if (!userId) return next();

  const now   = Date.now();
  const key   = String(userId);
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
      message:        `Demasiadas solicitudes. Límite: ${MAX_REQUESTS} por ${WINDOW_MS / 1000}s. Intentá en un momento.`,
      retry_after_ms: retryAfterMs,
    });
  }

  entry.count += 1;
  return next();
}
