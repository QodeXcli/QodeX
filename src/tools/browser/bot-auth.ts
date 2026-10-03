/**
 * Web Bot Auth — an OPT-IN, honest identity for the agent, the opposite of hiding that
 * it is automated. QodeX signs its own requests with an Ed25519 key so a site can
 * recognise "this is QodeX, acting for its user" and decide to let it through. It never
 * masks the browser, spoofs a fingerprint or forges human input; a site is free to
 * ignore the signature, and nothing here changes what the browser otherwise reveals.
 *
 * It implements HTTP Message Signatures (RFC 9421) with the Web Bot Auth tag
 * `web-bot-auth` (the Cloudflare / IETF draft). Each signed request carries:
 *   Signature-Agent: "<directory URL>"        the public-key directory the user hosts
 *   Signature-Input:  sig1=("@authority" "signature-agent");created=…;expires=…;keyid="…";alg="ed25519";tag="web-bot-auth"
 *   Signature:        sig1=:<base64>:
 * The signature covers only the target `@authority` and the `signature-agent` value, so
 * it is identical for every request to one host within its validity window (cached), and
 * carries no path, query or body.
 *
 * The private key lives in ~/.qodex/browser/bot-auth/ (0600) and never leaves the
 * machine. Only the public key is published, as a JWK Set at the directory URL
 * (`qodex browser bot-auth --directory`). A site that chooses to trust QodeX fetches
 * that directory and verifies the signature; QodeX earns fewer bot challenges by being
 * identifiable, not by evading detection.
 *
 * Off by default. This module is pure (keys, config, signing, status); the browser
 * wiring that adds the headers to live requests lives in session.ts.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  createHash,
  type KeyObject,
} from 'crypto';
import { QODEX_BROWSER_BOT_AUTH_DIR } from '../../config/paths.js';
import { logger } from '../../utils/logger.js';

/** Where the key lives by default. */
export const BOT_AUTH_DIR = QODEX_BROWSER_BOT_AUTH_DIR;
export const BOT_AUTH_KEY_FILE = path.join(BOT_AUTH_DIR, 'ed25519.pem');

/** The conventional path a directory URL ends in (informational). */
export const WELL_KNOWN_DIRECTORY = '/.well-known/http-message-signatures-directory';

/** The Web Bot Auth signature tag. */
export const WEB_BOT_AUTH_TAG = 'web-bot-auth';

export interface BotAuthConfig {
  /** Sign the agent's own requests with the Web Bot Auth key. Default false. */
  enabled: boolean;
  /**
   * The HTTPS URL where you publish the public key directory (the `Signature-Agent`
   * value). Empty = sign with `keyid` only (still valid RFC 9421, but a verifier must
   * already know the key). A site uses this URL to fetch and trust the key.
   */
  directoryUrl: string;
  /** PEM (PKCS8) private key file. Default ~/.qodex/browser/bot-auth/ed25519.pem. */
  keyFile: string;
  /** How long each signature stays valid, in seconds (it is cached for this long). */
  maxAgeSec: number;
}

export const DEFAULT_BOT_AUTH_CONFIG: BotAuthConfig = {
  enabled: false,
  directoryUrl: '',
  keyFile: BOT_AUTH_KEY_FILE,
  maxAgeSec: 900,
};

function str(v: unknown, d: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : d;
}
function num(v: unknown, d: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
}

/**
 * Resolve `browser.botAuth` from a raw config section. Accepts `true`/`false`, `"on"`/
 * `"off"`, or an object. Total: never throws, always returns a full config.
 */
export function resolveBotAuthConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): BotAuthConfig {
  const d = DEFAULT_BOT_AUTH_CONFIG;
  let s: Record<string, unknown> = {};
  let enabled = d.enabled;
  if (raw === true || raw === 'on') enabled = true;
  else if (raw === false || raw === 'off' || raw === null || raw === undefined) enabled = false;
  else if (typeof raw === 'object') {
    s = raw as Record<string, unknown>;
    enabled = s.enabled === true || s.enabled === 'on';
  }
  if (env.QODEX_BROWSER_BOT_AUTH === '1') enabled = true;
  if (env.QODEX_BROWSER_BOT_AUTH === '0') enabled = false;
  return {
    enabled,
    directoryUrl: normalizeDirectoryUrl(str(env.QODEX_BROWSER_BOT_AUTH_DIRECTORY || s.directoryUrl, d.directoryUrl)),
    keyFile: str(env.QODEX_BROWSER_BOT_AUTH_KEY || s.keyFile, d.keyFile),
    maxAgeSec: num(s.maxAgeSec, d.maxAgeSec, 30, 86_400),
  };
}

/** Drop a trailing slash and reject anything that is not an http(s) URL. PURE. */
export function normalizeDirectoryUrl(url: string): string {
  if (!url) return '';
  let u: URL;
  try { u = new URL(url); } catch { return ''; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  return u.toString().replace(/\/$/, '');
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The public JWK for an Ed25519 key. PURE. */
export function publicJwk(key: KeyObject): { kty: 'OKP'; crv: 'Ed25519'; x: string } {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { x?: string };
  return { kty: 'OKP', crv: 'Ed25519', x: String(jwk.x ?? '') };
}

/** RFC 7638 JWK thumbprint (base64url SHA-256) — the stable key id. PURE. */
export function jwkThumbprint(jwk: { kty: string; crv: string; x: string }): string {
  // Members in lexicographic order, no whitespace: crv, kty, x.
  const canon = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  return b64url(createHash('sha256').update(canon).digest());
}

/** Serialise a Structured-Fields string (RFC 8941): double-quoted, backslash-escaped. PURE. */
export function sfString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The authority (host[:port], lowercased, default ports dropped) for a URL. PURE, '' on failure. */
export function authorityOf(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  if (!host) return '';
  const port = u.port;
  const isDefault = (u.protocol === 'https:' && port === '443') || (u.protocol === 'http:' && port === '80');
  return port && !isDefault ? `${host}:${port}` : host;
}

export interface SignedHeaders {
  'Signature-Input': string;
  Signature: string;
  'Signature-Agent'?: string;
}

/**
 * Build the signature base and headers for one authority. PURE given the key and clock.
 * Covers `@authority` and (when a directory URL is set) `signature-agent`.
 */
export function buildSignature(opts: {
  key: KeyObject;
  keyid: string;
  authority: string;
  directoryUrl: string;
  created: number;
  expires: number;
}): SignedHeaders {
  const { key, keyid, authority, directoryUrl, created, expires } = opts;
  const withAgent = !!directoryUrl;
  const covered = withAgent ? '("@authority" "signature-agent")' : '("@authority")';
  const params = `${covered};created=${created};expires=${expires};keyid=${sfString(keyid)};alg="ed25519";tag=${sfString(WEB_BOT_AUTH_TAG)}`;
  const lines = [`"@authority": ${authority}`];
  if (withAgent) lines.push(`"signature-agent": ${sfString(directoryUrl)}`);
  lines.push(`"@signature-params": ${params}`);
  const base = lines.join('\n');
  const signature = cryptoSign(null, Buffer.from(base, 'utf8'), key);
  const headers: SignedHeaders = {
    'Signature-Input': `sig1=${params}`,
    Signature: `sig1=:${signature.toString('base64')}:`,
  };
  if (withAgent) headers['Signature-Agent'] = sfString(directoryUrl);
  return headers;
}

export interface BotAuthStatus {
  enabled: boolean;
  keyid?: string;
  directoryUrl?: string;
  /** Requests signed this session. */
  signed: number;
  /** There is a published directory URL, so a site can fetch the key. */
  hasDirectory: boolean;
}

/**
 * Loads (or creates) the key and hands out signed headers per authority, cached until
 * each signature is close to expiry. Construct with `BotAuthSigner.load(cfg)`.
 */
export class BotAuthSigner {
  private readonly cache = new Map<string, { headers: SignedHeaders; expires: number }>();
  private signedCount = 0;

  private constructor(
    private readonly key: KeyObject,
    readonly keyid: string,
    readonly directoryUrl: string,
    private readonly maxAgeSec: number,
    private readonly now: () => number,
  ) {}

  /** Load the signer, creating the key on first use. `now` is injectable for tests. */
  static async load(cfg: BotAuthConfig, now: () => number = Date.now): Promise<BotAuthSigner> {
    const key = await loadOrCreateKey(cfg.keyFile);
    const keyid = jwkThumbprint(publicJwk(key));
    return new BotAuthSigner(key, keyid, normalizeDirectoryUrl(cfg.directoryUrl), cfg.maxAgeSec, now);
  }

  /** Signed headers for an authority (host[:port]), cached within the validity window. */
  headersForAuthority(authority: string): SignedHeaders {
    const nowSec = Math.floor(this.now() / 1000);
    const hit = this.cache.get(authority);
    // Re-sign once the window is within 30 s of expiry so a request never carries a
    // just-expired signature.
    if (hit && hit.expires - nowSec > 30) return hit.headers;
    const created = nowSec;
    const expires = created + this.maxAgeSec;
    const headers = buildSignature({ key: this.key, keyid: this.keyid, authority, directoryUrl: this.directoryUrl, created, expires });
    this.cache.set(authority, { headers, expires });
    if (this.cache.size > 256) {
      for (const [k, v] of this.cache) if (v.expires <= nowSec) this.cache.delete(k);
    }
    return headers;
  }

  /** Signed headers for a full URL ('' authority → none). Counts the request as signed. */
  headersForUrl(url: string): SignedHeaders | null {
    const authority = authorityOf(url);
    if (!authority) return null;
    this.signedCount++;
    return this.headersForAuthority(authority);
  }

  /** The public key directory to publish at directoryUrl (a JWK Set). */
  directory(): { keys: Array<{ kty: string; crv: string; x: string; kid: string; use: string }> } {
    return { keys: [{ ...publicJwk(this.key), kid: this.keyid, use: 'sig' }] };
  }

  status(enabled: boolean): BotAuthStatus {
    return {
      enabled,
      keyid: this.keyid,
      directoryUrl: this.directoryUrl || undefined,
      signed: this.signedCount,
      hasDirectory: !!this.directoryUrl,
    };
  }
}

/** Read the Ed25519 private key, generating and persisting one (0600) on first use. */
export async function loadOrCreateKey(keyFile: string): Promise<KeyObject> {
  try {
    const pem = await fs.readFile(keyFile, 'utf8');
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error(`the key in ${keyFile} is ${key.asymmetricKeyType ?? 'unknown'}, not ed25519`);
    }
    return key;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      // A present-but-bad key is a real error: do not silently overwrite the user's key.
      if (e?.code === undefined && /ed25519/.test(String(e?.message))) throw e;
      if (e?.code && e.code !== 'ENOENT') throw e;
    }
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  await fs.writeFile(keyFile, pem, { mode: 0o600 });
  await fs.chmod(keyFile, 0o600).catch(() => {});
  logger.info('Web Bot Auth: created a new signing key', { keyFile });
  return privateKey;
}
