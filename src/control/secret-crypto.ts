/**
 * Secret transport for the control center: how a password typed into the web
 * secret form travels to this process, and where that is allowed at all.
 *
 *   classifySecretTransport(req) — decides per request:
 *     'local'   the browser talks to us directly over loopback (or TLS): plain
 *               JSON is acceptable (the page still seals it — defense in depth);
 *     'tunnel'  the request came through a proxy/tunnel (cloudflared, ngrok):
 *               TLS ends at the provider, so the PAGE must seal the secret with
 *               crypto.subtle for a per-request server key — plaintext refused;
 *     'refused' anything else (plain-http LAN): cleartext on the network and no
 *               crypto.subtle (not a secure context) — the form is refused with a
 *               clear message.
 *   SecretKeyStore — short-lived, single-use ECDH P-256 key pairs. The page
 *     derives an AES-256-GCM key from ECDH + HKDF-SHA256 (salt "qodex-secret:v1",
 *     info = key id) and sends {kid, epk, iv, ct}; we decrypt in memory only.
 *   SECRET_SEAL_JS — the page-side sealing function as plain JS source. The
 *     dashboard embeds this exact string and the tests evaluate it with
 *     `new Function` against Node's WebCrypto, so both run the same code.
 *
 * Nothing here logs, stores or returns plaintext except the opened value to the
 * caller; errors are fixed codes (a decryption failure never echoes input).
 */

import { createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export type SecretTransport = 'local' | 'tunnel' | 'refused';

export interface TransportVerdict {
  transport: SecretTransport;
  /** Why it was refused (English; the dashboard shows a localized text by code). */
  reason?: string;
}

/** Headers set by reverse proxies / tunnels. Any of them means "not a direct client". */
const FORWARD_HEADERS = [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip',
  'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'true-client-ip', 'x-original-host',
];

function isLoopbackAddress(addr: string | undefined): boolean {
  const a = String(addr ?? '').toLowerCase().replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

function isLoopbackName(hostHeader: string): boolean {
  let h = String(hostHeader ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined);
  else h = h.replace(/:\d+$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function first(v: string | string[] | undefined): string {
  return String(Array.isArray(v) ? v[0] : v ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Where may a secret come from on this request? PURE (looks at the socket's remote
 * address, whether it is TLS, and the request headers).
 *
 * A tunnel client (cloudflared / ngrok) connects to us FROM loopback, so a loopback
 * socket alone is not "local": proxy headers or a non-loopback Host mean the bytes
 * crossed a third party. A non-loopback socket without TLS is plain-http LAN — the
 * forwarding headers it sends are not trusted to upgrade it.
 */
export function classifySecretTransport(req: {
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string; encrypted?: boolean } | null;
}): TransportVerdict {
  const sock = req.socket ?? {};
  const forwarded = FORWARD_HEADERS.some(h => req.headers[h] !== undefined)
    || Object.keys(req.headers).some(k => k.startsWith('ngrok-'));
  if (sock.encrypted && !forwarded) return { transport: 'local' };
  if (isLoopbackAddress(sock.remoteAddress)) {
    if (!forwarded && isLoopbackName(String(req.headers.host ?? ''))) return { transport: 'local' };
    const proto = first(req.headers['x-forwarded-proto']);
    const cfVisitor = String(req.headers['cf-visitor'] ?? '');
    const https = proto === 'https' || /"scheme"\s*:\s*"https"/.test(cfVisitor) || /proto=https/i.test(String(req.headers.forwarded ?? ''));
    if (https) return { transport: 'tunnel' };
    return { transport: 'refused', reason: 'the request came through a proxy without https' };
  }
  return {
    transport: 'refused',
    reason: 'plain http on the local network would send the password in clear text — open the control center on this computer (localhost) or through its https link',
  };
}

// ── sealing (page → server) ─────────────────────────────────────────────────

/** The envelope the page posts instead of plaintext. All fields base64. */
export interface SealedSecret {
  kid: string;
  /** The page's ephemeral ECDH P-256 public key, raw uncompressed (65 bytes). */
  epk: string;
  iv: string;
  /** AES-256-GCM ciphertext with the 16-byte tag appended (WebCrypto layout). */
  ct: string;
}

const SALT = Buffer.from('qodex-secret:v1');
const aadFor = (kid: string) => Buffer.from(`qodex-secret:v1|${kid}`);

export function isSealedSecret(v: unknown): v is SealedSecret {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return ['kid', 'epk', 'iv', 'ct'].every(k => typeof o[k] === 'string' && (o[k] as string).length > 0 && (o[k] as string).length <= 16_384);
}

interface KeyEntry {
  ecdh: ECDH;
  /** What the key may unlock (a request id, or a vault-panel operation scope). */
  bind: string;
  expiresAt: number;
}

/** Short-lived single-use ECDH keys, one per secret request / vault form. */
export class SecretKeyStore {
  private keys = new Map<string, KeyEntry>();

  constructor(private readonly ttlMs = 15 * 60_000, private readonly now: () => number = Date.now) {}

  /** A fresh key bound to `bind`. Returns its id and the raw public key (base64). */
  mint(bind: string): { kid: string; publicKey: string; expiresAt: number } {
    this.sweep();
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const kid = 'k_' + randomBytes(12).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.keys.set(kid, { ecdh, bind, expiresAt });
    // Bound memory: a page polling for keys can't grow this without limit.
    if (this.keys.size > 64) {
      const oldest = this.keys.keys().next().value as string | undefined;
      if (oldest) this.keys.delete(oldest);
    }
    return { kid, publicKey: ecdh.getPublicKey().toString('base64'), expiresAt };
  }

  has(kid: string): boolean {
    this.sweep();
    return this.keys.has(kid);
  }

  /**
   * Decrypt an envelope for `bind`. Single use: the key is deleted whatever the
   * outcome. Throws `[SECRET_SEAL_INVALID]` (never echoing input) on any failure.
   */
  open(env: SealedSecret, bind: string): Buffer {
    this.sweep();
    const k = this.keys.get(env.kid);
    this.keys.delete(env.kid);
    if (!k || k.bind !== bind) throw new Error('[SECRET_SEAL_INVALID] the form key expired or does not belong to this request — reload the page and try again');
    try {
      const shared = k.ecdh.computeSecret(Buffer.from(env.epk, 'base64'));
      const key = Buffer.from(hkdfSync('sha256', shared, SALT, Buffer.from(env.kid), 32));
      const iv = Buffer.from(env.iv, 'base64');
      const all = Buffer.from(env.ct, 'base64');
      if (iv.length !== 12 || all.length < 17) throw new Error('bad sizes');
      const d = createDecipheriv('aes-256-gcm', key, iv);
      d.setAAD(aadFor(env.kid));
      d.setAuthTag(all.subarray(all.length - 16));
      return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]);
    } catch {
      throw new Error('[SECRET_SEAL_INVALID] the sealed form could not be opened — reload the page and try again');
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [kid, k] of this.keys) if (k.expiresAt <= now) this.keys.delete(kid);
  }

  /** Test helper. */
  clear(): void {
    this.keys.clear();
  }
}

/**
 * Page-side sealing as plain JS (no DOM; ES2017 promises). Embedded verbatim in the
 * dashboard script and evaluated by the tests with Node's WebCrypto:
 *   qxSealSecret(cryptoObj, publicKeyB64, kid, payloadObject) → Promise<{kid, epk, iv, ct}>
 */
export const SECRET_SEAL_JS = String.raw`
function qxB64ToBytes(b64) {
  var bin = atob(String(b64 || '')), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function qxBytesToB64(buf) {
  var bytes = new Uint8Array(buf), s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function qxSealSecret(cryptoObj, publicKeyB64, kid, payload) {
  var subtle = cryptoObj && cryptoObj.subtle;
  if (!subtle) return Promise.reject(new Error('no-subtle'));
  var enc = new TextEncoder();
  var curve = { name: 'ECDH', namedCurve: 'P-256' };
  var eph, aesKey;
  return subtle.generateKey(curve, true, ['deriveBits']).then(function (pair) {
    eph = pair;
    return subtle.importKey('raw', qxB64ToBytes(publicKeyB64), curve, false, []);
  }).then(function (serverKey) {
    return subtle.deriveBits({ name: 'ECDH', public: serverKey }, eph.privateKey, 256);
  }).then(function (bits) {
    return subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  }).then(function (hk) {
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('qodex-secret:v1'), info: enc.encode(kid) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  }).then(function (k) {
    aesKey = k;
    var iv = cryptoObj.getRandomValues(new Uint8Array(12));
    return Promise.all([
      subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode('qodex-secret:v1|' + kid) }, aesKey, enc.encode(JSON.stringify(payload))),
      subtle.exportKey('raw', eph.publicKey),
      Promise.resolve(iv)
    ]);
  }).then(function (r) {
    return { kid: kid, epk: qxBytesToB64(r[1]), iv: qxBytesToB64(r[2]), ct: qxBytesToB64(r[0]) };
  });
}
`;
