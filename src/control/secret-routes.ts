/**
 * Control-center routes for secret entry and the vault panel. Mounted by
 * src/control/server.ts after authentication, the agent-browser refusal and the
 * CSRF check; everything here adds its own, stricter rules:
 *
 *   - FULL token only: any narrower credential (a scoped hand-off link) is refused;
 *   - transport (src/control/secret-crypto.ts): loopback or https only — plain-http
 *     LAN is refused outright, and over a tunnel a secret must arrive SEALED by the
 *     page (crypto.subtle, a single-use key bound to that request / entry);
 *   - values go straight into the vault (SecretRequestBroker.answer for requests,
 *     the vault itself for the panel) and are dropped; responses carry summaries;
 *   - bodies are never logged, errors are fixed codes or scrubbed of typed values,
 *     and the vault list never reveals a secret (usernames are masked).
 *
 *   GET  /api/secrets                pending login requests (+ per-request seal key)
 *   POST /api/secrets/<id>           {sealed} | {username?, password, totp?} | {cancel: true}
 *   GET  /api/vault                  entry summaries (masked usernames)
 *   GET  /api/vault/key?op=&name=    a single-use seal key for one add / rotate
 *   POST /api/vault/add              {name, origins, username?, sealed | password, totp?}
 *   POST /api/vault/rotate           {name, sealed | {password?, totp?}}
 *   POST /api/vault/edit             {name, origins?, username?, loginUrl?}
 *   POST /api/vault/remove           {name, confirm: <name>}
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getBus } from './bus.js';
import { classifySecretTransport, isSealedSecret, SecretKeyStore, type TransportVerdict } from './secret-crypto.js';
import {
  getSecretRequestBroker, maskUsername, scrubSecretError, vaultUpdate,
  type SecretAnswer, type VaultLike, type VaultPatch,
} from '../vault/requests.js';
import { getVault, normalizeOrigin, formatOrigin, validateEntryName } from '../vault/vault.js';

const MAX_BODY = 64 * 1024;

const HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Single-use seal keys for requests (bind "req:<id>") and panel forms ("vault:<op>:<name>"). */
const keys = new SecretKeyStore();
/** Request id → its current seal key id (re-minted when used or expired). */
const requestKeys = new Map<string, string>();

let vaultProvider: () => VaultLike = getVault;

/** Test hook: point the vault panel at a temp vault (null = the default vault). */
export function setSecretRoutesVaultForTests(fn: (() => VaultLike) | null): void {
  vaultProvider = fn ?? getVault;
}

/** Test hook: forget every seal key. */
export function resetSecretRoutesForTests(): void {
  keys.clear();
  requestKeys.clear();
}

/** Does `path` belong to this module? PURE. */
export function isSecretRoute(path: string): boolean {
  return /^\/api\/(?:secrets|vault)(?:\/|$)/.test(String(path ?? ''));
}

export interface SecretRouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  query: string;
  method: string;
  /** How the request authenticated (server.ts authenticateRequest().via). */
  authVia: string;
}

/** Credentials that grant the whole control center. Anything else (scoped links) is refused here. */
const FULL_AUTH = new Set(['query', 'bearer', 'cookie']);

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)) });
  res.end(text);
}

function fail(res: ServerResponse, status: number, error: string): void {
  send(res, status, { ok: false, error });
}

function drain(req: IncomingMessage): void {
  req.on('error', () => {});
  req.resume();
}

/** Read a JSON body (≤64KB). Never echoes it; returns null after answering an error. */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
    drain(req);
    fail(res, 415, '[UNSUPPORTED_MEDIA_TYPE] Send a JSON body with Content-Type: application/json.');
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const ok = await new Promise<boolean>((resolve) => {
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { resolve(false); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('close', () => resolve(size <= MAX_BODY));
  });
  if (!ok) {
    drain(req);
    fail(res, 413, '[PAYLOAD_TOO_LARGE] Request bodies are limited to 64KB.');
    return null;
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through — never quote the body */ }
  fail(res, 400, '[BAD_JSON] The request body is not a JSON object.');
  return null;
}

function str(v: unknown, max = 4096): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

function notice(message: string): void {
  try { getBus().publish({ kind: 'notice', level: 'info', message }); } catch { /* ignore */ }
}

/** Status for a `[CODE] …` vault error. PURE. */
function statusOf(message: string): number {
  const code = /^\[([A-Z0-9_]+)\]/.exec(message)?.[1] ?? '';
  if (/NOT_FOUND$/.test(code)) return 404;
  if (code === 'VAULT_EXISTS') return 409;
  if (/(INVALID|EMPTY|TOO_LONG|REFUSED|REQUIRED|UNSUPPORTED|MISMATCH)$/.test(code) || code === 'TOTP_INVALID') return 400;
  return 500;
}

/**
 * The secret fields of a body: opened from `sealed` (bound to `bind`), or taken
 * plain — which only a direct loopback / TLS connection may send.
 */
function secretFields(body: Record<string, unknown>, verdict: TransportVerdict, bind: string): { ok: true; values: SecretAnswer } | { ok: false; status: number; error: string } {
  if (body.sealed !== undefined) {
    if (!isSealedSecret(body.sealed)) return { ok: false, status: 400, error: '[SECRET_SEAL_INVALID] malformed sealed form' };
    let plain: Buffer;
    try { plain = keys.open(body.sealed, bind); } catch (e) { return { ok: false, status: 400, error: scrubSecretError(e, []) }; }
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(plain.toString('utf8')) as Record<string, unknown>; } catch { parsed = {}; }
    plain.fill(0);
    return { ok: true, values: { username: str(parsed.username, 512), password: str(parsed.password), totp: str(parsed.totp, 2048) } };
  }
  const hasPlain = ['password', 'totp'].some(k => body[k] !== undefined);
  if (!hasPlain) return { ok: true, values: {} };
  if (verdict.transport !== 'local') {
    return { ok: false, status: 400, error: '[SECRET_SEAL_REQUIRED] Over a tunnel the form must be sealed in the page — reload the control center and try again.' };
  }
  return { ok: true, values: { username: str(body.username, 512), password: str(body.password), totp: str(body.totp, 2048) } };
}

function refused(res: ServerResponse, verdict: TransportVerdict): void {
  fail(res, 403, `[SECRET_TRANSPORT_REFUSED] ${verdict.reason ?? 'this connection cannot carry a password'}`);
}

/** Handle one /api/secrets or /api/vault request. Never throws; never logs a body. */
export async function handleSecretRoute(r: SecretRouteRequest): Promise<void> {
  const { req, res } = r;
  const isRead = r.method === 'GET' || r.method === 'HEAD';
  try {
    if (!FULL_AUTH.has(r.authVia)) {
      if (!isRead) drain(req);
      fail(res, 403, '[SECRET_SCOPE] This link cannot enter or manage secrets. Open the full control-center link.');
      return;
    }
    const verdict = classifySecretTransport(req);
    const m = r.path.match(/^\/api\/secrets\/([A-Za-z0-9_-]{1,64})$/);
    if (r.path === '/api/secrets') {
      if (!isRead) { drain(req); fail(res, 405, '[METHOD_NOT_ALLOWED] Use GET.'); return; }
      return listRequests(res, verdict);
    }
    if (m) {
      if (r.method !== 'POST') { if (!isRead) drain(req); fail(res, 405, '[METHOD_NOT_ALLOWED] Use POST.'); return; }
      return await answerRequest(r, m[1]!, verdict);
    }
    if (r.path === '/api/vault') {
      if (!isRead) { drain(req); fail(res, 405, '[METHOD_NOT_ALLOWED] Use GET.'); return; }
      return await listVault(res, verdict);
    }
    if (r.path === '/api/vault/key') {
      if (!isRead) { drain(req); fail(res, 405, '[METHOD_NOT_ALLOWED] Use GET.'); return; }
      return vaultKey(r, verdict);
    }
    const op = r.path.match(/^\/api\/vault\/(add|rotate|edit|remove)$/)?.[1];
    if (op) {
      if (r.method !== 'POST') { if (!isRead) drain(req); fail(res, 405, '[METHOD_NOT_ALLOWED] Use POST.'); return; }
      return await vaultOp(r, op as 'add' | 'rotate' | 'edit' | 'remove', verdict);
    }
    if (!isRead) drain(req);
    fail(res, 404, `[NOT_FOUND] ${r.path.slice(0, 120)}`);
  } catch {
    // Never let a value-bearing exception reach the log or the response.
    if (!res.headersSent) fail(res, 500, '[SECRET_ROUTE_FAILED] The request could not be completed.');
    else { try { res.end(); } catch { /* ignore */ } }
  }
}

// ── login requests ──────────────────────────────────────────────────────────

function requestKey(id: string): { kid: string; publicKey: string } | null {
  const kid = requestKeys.get(id);
  // A key's public half is not kept separately: re-mint whenever the old one is gone.
  if (kid && keys.has(kid)) {
    const pub = publicKeys.get(kid);
    if (pub) return { kid, publicKey: pub };
  }
  const k = keys.mint(`req:${id}`);
  requestKeys.set(id, k.kid);
  publicKeys.set(k.kid, k.publicKey);
  if (publicKeys.size > 128) publicKeys.delete(publicKeys.keys().next().value as string);
  return { kid: k.kid, publicKey: k.publicKey };
}
const publicKeys = new Map<string, string>();

function listRequests(res: ServerResponse, verdict: TransportVerdict): void {
  const pending = getSecretRequestBroker().pending();
  for (const id of [...requestKeys.keys()]) if (!pending.some(p => p.id === id)) requestKeys.delete(id);
  const requests = pending.map(p => ({
    id: p.id, entryName: p.entryName, origins: p.origins, host: p.host, displayHost: p.displayHost,
    fields: p.fields, reason: p.reason, usernameHint: p.usernameHint, warning: p.warning, existing: p.existing,
    createdAt: p.createdAt, expiresAt: p.expiresAt,
    ...(verdict.transport === 'refused' ? {} : { seal: requestKey(p.id) }),
  }));
  send(res, 200, { ok: true, transport: verdict.transport, ...(verdict.reason ? { reason: verdict.reason } : {}), requests });
}

async function answerRequest(r: SecretRouteRequest, id: string, verdict: TransportVerdict): Promise<void> {
  const body = await readBody(r.req, r.res);
  if (!body) return;
  const broker = getSecretRequestBroker();
  if (!broker.get(id)) { fail(r.res, 404, '[SECRET_REQUEST_NOT_FOUND] That request was already answered, cancelled or expired.'); return; }
  if (body.cancel === true) {
    broker.cancel(id, 'control');
    send(r.res, 200, { ok: true, cancelled: true });
    return;
  }
  if (verdict.transport === 'refused') { refused(r.res, verdict); return; }
  const got = secretFields(body, verdict, `req:${id}`);
  if (!got.ok) { fail(r.res, got.status, got.error); return; }
  requestKeys.delete(id); // a used key is gone; the next GET mints a fresh one
  const out = await broker.answer(id, got.values, 'control');
  if (!out.ok) { fail(r.res, statusOf(out.error), out.error); return; }
  send(r.res, 200, { ok: true, saved: out.summary });
}

// ── vault panel ─────────────────────────────────────────────────────────────

async function listVault(res: ServerResponse, verdict: TransportVerdict): Promise<void> {
  if (verdict.transport === 'refused') {
    send(res, 200, { ok: true, transport: 'refused', reason: verdict.reason, entries: [] });
    return;
  }
  let list;
  try { list = await vaultProvider().list(); } catch (e) { fail(res, 500, scrubSecretError(e, [])); return; }
  const entries = list.map(e => ({
    name: e.name,
    origins: e.origins,
    user: maskUsername(e.username),
    fields: { username: e.hasUsername, password: e.hasSecret, totp: e.hasTotp },
    ...((e as { loginUrl?: unknown }).loginUrl ? { loginUrl: String((e as { loginUrl?: unknown }).loginUrl) } : {}),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }));
  send(res, 200, { ok: true, transport: verdict.transport, entries });
}

function panelBind(op: string, name: string): string {
  return `vault:${op}:${String(name).trim().toLowerCase()}`;
}

function vaultKey(r: SecretRouteRequest, verdict: TransportVerdict): void {
  if (verdict.transport === 'refused') { refused(r.res, verdict); return; }
  const q = new URLSearchParams(r.query);
  const op = q.get('op') ?? '';
  const name = q.get('name') ?? '';
  if (!['add', 'rotate'].includes(op) || !name || name.length > 64) { fail(r.res, 400, '[INVALID_INPUT] Use ?op=add|rotate&name=<entry>.'); return; }
  const k = keys.mint(panelBind(op, name));
  send(r.res, 200, { ok: true, kid: k.kid, publicKey: k.publicKey, expiresAt: k.expiresAt });
}

function parseOrigins(v: unknown): string[] | null {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null;
  if (!raw) return null;
  const out: string[] = [];
  for (const o of raw.slice(0, 20)) {
    if (typeof o !== 'string' || !o.trim()) continue;
    const n = normalizeOrigin(o);
    if (!n) return null;
    out.push(formatOrigin(n));
  }
  return out.length ? [...new Set(out)] : null;
}

async function vaultOp(r: SecretRouteRequest, op: 'add' | 'rotate' | 'edit' | 'remove', verdict: TransportVerdict): Promise<void> {
  if (verdict.transport === 'refused') { drain(r.req); refused(r.res, verdict); return; }
  const body = await readBody(r.req, r.res);
  if (!body) return;
  const vault = vaultProvider();
  const nameRaw = str(body.name, 64) ?? '';
  let name: string;
  try { name = validateEntryName(nameRaw); } catch (e) { fail(r.res, 400, scrubSecretError(e, [])); return; }
  let typed: Array<string | undefined> = [];
  try {
    if (op === 'add' || op === 'rotate') {
      const got = secretFields(body, verdict, panelBind(op, name));
      if (!got.ok) { fail(r.res, got.status, got.error); return; }
      const v = got.values;
      typed = [v.password, v.totp];
      if (op === 'add') {
        const origins = parseOrigins(body.origins);
        if (!origins) { fail(r.res, 400, '[VAULT_INVALID] Give at least one valid site (https, or http only for localhost).'); return; }
        if (!v.password) { fail(r.res, 400, '[SECRET_EMPTY] The password is empty.'); return; }
        const username = str(body.username, 512)?.trim() || v.username?.trim() || undefined;
        const s = await vault.add({ name, origins, username, secret: v.password, totp: v.totp?.trim() || undefined });
        notice(`🔐 Vault: added "${s.name}" (${s.origins.join(', ')}) from the control center.`);
        send(r.res, 200, { ok: true, entry: { name: s.name, origins: s.origins } });
        return;
      }
      if (!v.password && !v.totp) { fail(r.res, 400, '[SECRET_EMPTY] Enter a new password or a new 2FA key.'); return; }
      const patch: VaultPatch = { ...(v.password ? { secret: v.password } : {}), ...(v.totp?.trim() ? { totp: v.totp.trim() } : {}) };
      const s = await vaultUpdate(vault, name, patch);
      notice(`🔐 Vault: rotated ${v.password ? 'the password' : ''}${v.password && v.totp ? ' and ' : ''}${v.totp ? 'the 2FA key' : ''} of "${s.name}" from the control center.`);
      send(r.res, 200, { ok: true, entry: { name: s.name, origins: s.origins } });
      return;
    }
    if (body.password !== undefined || body.totp !== undefined || body.sealed !== undefined) {
      fail(r.res, 400, '[SECRET_FIELD_REFUSED] Secrets are changed with rotate, not edit.');
      return;
    }
    if (op === 'edit') {
      const patch: VaultPatch = {};
      if (body.origins !== undefined) {
        const origins = parseOrigins(body.origins);
        if (!origins) { fail(r.res, 400, '[VAULT_INVALID] Give at least one valid site (https, or http only for localhost).'); return; }
        patch.origins = origins;
      }
      if (body.username !== undefined) patch.username = (str(body.username, 512) ?? '').trim() || null;
      if (body.loginUrl !== undefined) {
        const u = (str(body.loginUrl, 2048) ?? '').trim();
        if (u && !/^https?:\/\//i.test(u)) { fail(r.res, 400, '[VAULT_INVALID] The login URL must start with https://'); return; }
        patch.loginUrl = u || null;
      }
      if (!Object.keys(patch).length) { fail(r.res, 400, '[INVALID_INPUT] Nothing to change.'); return; }
      const s = await vaultUpdate(vault, name, patch);
      notice(`🔐 Vault: edited "${s.name}" (${Object.keys(patch).join(', ')}) from the control center.`);
      send(r.res, 200, { ok: true, entry: { name: s.name, origins: s.origins } });
      return;
    }
    // remove — the body must repeat the exact name (the dashboard asks first).
    if (str(body.confirm, 64)?.trim().toLowerCase() !== name.toLowerCase()) {
      fail(r.res, 400, '[CONFIRM_REQUIRED] Repeat the entry name in "confirm" to delete it.');
      return;
    }
    const gone = await vault.remove(name);
    if (!gone) { fail(r.res, 404, `[VAULT_NOT_FOUND] No vault entry named "${name}".`); return; }
    notice(`🔐 Vault: deleted "${name}" from the control center.`);
    send(r.res, 200, { ok: true, removed: name });
  } catch (e) {
    const msg = scrubSecretError(e, typed);
    fail(r.res, statusOf(msg), msg);
  } finally {
    typed = [];
  }
}
