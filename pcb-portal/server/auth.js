import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { rateLimit as expressRateLimit } from 'express-rate-limit';

const scrypt = promisify(scryptCb);
export const SESSION_COOKIE = 'qx_sid';
const SESSION_DAYS = 30;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(key, expected);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  return { token, expires };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** Read one cookie by name (no generic parsing into an object keyed by user input). */
export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function sessionCookie(token, { secure, expires }) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (expires) parts.push(`Expires=${new Date(expires).toUTCString()}`);
  else parts.push('Max-Age=0');
  return parts.join('; ');
}

/** Attaches req.user (or null) from the session cookie. */
export function sessionMiddleware(db) {
  const find = db.prepare(`
    SELECT u.id, u.email, u.name, u.phone, u.company, u.country, u.role, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`);
  const purge = db.prepare("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  let lastPurge = 0;
  return (req, _res, next) => {
    if (Date.now() - lastPurge > 3600e3) {
      purge.run();
      lastPurge = Date.now();
    }
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    req.sessionToken = token || null;
    req.user = null;
    if (token) {
      const row = find.get(sha256(token));
      if (row && new Date(row.expires_at) > new Date()) {
        delete row.expires_at;
        req.user = row;
      }
    }
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}

/**
 * CSRF guard for cookie-authenticated APIs: every state-changing request must
 * carry a custom header, which a cross-site form/navigation cannot set without a
 * CORS preflight (and we never answer preflights).
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-qodex-request') !== '1') return res.status(403).json({ error: 'Invalid request (missing CSRF header).' });
  next();
}

/** Rate limiter (express-rate-limit) with a JSON error body. */
export function limiter({ windowMs, limit }) {
  return expressRateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again in a few minutes.' },
  });
}
