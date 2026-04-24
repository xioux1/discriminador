import jwt from 'jsonwebtoken';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is required');
  return s;
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  try {
    req.user = jwt.verify(token, getSecret());
    if (!req.user?.id) {
      return res.status(401).json({ error: 'token_invalid', message: 'Invalid or expired token.' });
    }
    // Slide token: refresh only when less than 1 day left to avoid token storms on burst requests.
    const exp = req.user.exp;
    const oneDay = 24 * 3600;
    if (exp - Math.floor(Date.now() / 1000) < oneDay) {
      const { iat, exp: _exp, ...payload } = req.user;
      const fresh = jwt.sign(payload, getSecret(), { expiresIn: '30d' });
      res.setHeader('X-Refresh-Token', fresh);
    }
    next();
  } catch (_e) {
    return res.status(401).json({ error: 'token_invalid', message: 'Invalid or expired token.' });
  }
}

export function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: '30d' });
}
