import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { dbPool } from '../db/client.js';
import { signToken } from '../middleware/auth.js';

const authRouter = Router();
const SALT_ROUNDS = 12;

// POST /auth/register
authRouter.post('/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username?.trim() || !password || password.length < 6) {
    return res.status(422).json({ error: 'validation_error', message: 'username y contraseña (mín. 6 caracteres) son requeridos.' });
  }
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await dbPool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
      [username.trim().toLowerCase(), hash]
    );
    const user = rows[0];
    const token = signToken({ id: user.id, username: user.username });
    return res.status(201).json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'conflict', message: 'El nombre de usuario ya está en uso.' });
    }
    console.error('POST /auth/register', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /auth/login
authRouter.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username?.trim() || !password) {
    return res.status(422).json({ error: 'validation_error', message: 'username y contraseña son requeridos.' });
  }
  try {
    const { rows } = await dbPool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'unauthorized', message: 'Credenciales inválidas.' });
    }
    const token = signToken({ id: user.id, username: user.username });
    return res.status(200).json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('POST /auth/login', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /auth/logout  (client-side token deletion, server just confirms)
authRouter.post('/auth/logout', (_req, res) => {
  return res.status(200).json({ message: 'Sesión cerrada.' });
});

export default authRouter;
