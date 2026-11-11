/**
 * Host checks for ssh and telnet. Pure. A bad host must never become an ssh option.
 */

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/;
const USER = /^[A-Za-z0-9._-]{1,32}$/;

export function checkHost(raw: string): { ok: true; host: string } | { ok: false; error: string } {
  const host = (raw ?? '').trim();
  if (!host || host.startsWith('-') || /[\s@/\\]/.test(host)) {
    return { ok: false, error: `refusing host "${raw}"` };
  }
  if (HOSTNAME.test(host) || IPV4.test(host)) return { ok: true, host };
  if (host.includes(':') && IPV6.test(host) && !host.includes(':::')) return { ok: true, host };
  return { ok: false, error: `refusing host "${raw}"` };
}

export function checkUser(raw: string | undefined): { ok: true; user?: string } | { ok: false; error: string } {
  if (raw == null || raw.trim() === '') return { ok: true };
  const user = raw.trim();
  if (!USER.test(user)) return { ok: false, error: `refusing user "${raw}"` };
  return { ok: true, user };
}

export function checkPort(raw: number | undefined, fallback: number): { ok: true; port: number } | { ok: false; error: string } {
  const port = raw == null ? fallback : raw;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: `bad port ${raw}` };
  return { ok: true, port };
}

/** `user@host`, with IPv6 wrapped in brackets. */
export function destination(user: string | undefined, host: string): string {
  const h = host.includes(':') ? `[${host}]` : host;
  return user ? `${user}@${h}` : h;
}

export function checkIdentity(raw: string | undefined): { ok: true; file?: string } | { ok: false; error: string } {
  if (raw == null || raw.trim() === '') return { ok: true };
  const file = raw.trim().replace(/^~(?=\/)/, process.env.HOME || '~');
  if (file.startsWith('-') || /[\0\r\n]/.test(file)) return { ok: false, error: 'refusing identity file' };
  return { ok: true, file };
}
