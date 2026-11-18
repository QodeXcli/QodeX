/**
 * The lock on the host. A port without this token is not opened.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function bindAllowed(host: string, token: string): { ok: true } | { ok: false; reason: string } {
  if (!token || token.length < 32) return { ok: false, reason: 'host token is missing or shorter than 32 characters' };
  if (!loopback(host) && host !== '0.0.0.0') {
    /* a named LAN or Tailscale address is allowed only because the token exists */
  }
  return { ok: true };
}

export function bearerOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)$/.exec(header ?? '');
  const got = m?.[1] ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export async function ensureHostToken(file: string): Promise<string> {
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch { /* create it */ }
  const token = randomBytes(32).toString('hex');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, token + '\n', { mode: 0o600 });
  return token;
}
