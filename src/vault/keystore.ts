/**
 * The vault key's home — ONE loader (`getVaultKey`) shared by the credential vault, the
 * mail accounts file and the mail drafts signer, so a migration moves the key for all.
 *
 * Backends (where the 32-byte key lives):
 *   file            QODEX_VAULT_KEY_FILE, base64, mode 0600 (the default; works anywhere)
 *   macos           the login Keychain, via `security` — written with `security -i` and
 *                   the command on STDIN, so the key never appears in argv / `ps`
 *   secret-service  GNOME Keyring / KWallet via `secret-tool`, secret on stdin (needs a
 *                   D-Bus session — not on headless servers or plain SSH)
 *   windows         DPAPI (CurrentUser) via PowerShell with the script on stdin; the sealed
 *                   blob is stored in .vault-key.dpapi next to the key file
 *
 * The backend in use is RECORDED in vault-keystore.json (next to the key file) together
 * with a fingerprint of the key (an HMAC, not the key). A missing key file is only ever
 * treated as a fresh install — and a new key minted — when there is no record AND none of
 * the files encrypted with the key exists. Otherwise it is `[*_KEY_MISSING]`, never a
 * second key that would orphan everything encrypted with the first.
 *
 * External commands run with async spawn, a sanitized environment (childEnv) and a
 * timeout. Their output never reaches an error message: a failure reports the exit code
 * and a scrubbed first line of stderr only.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_VAULT_FILE, QODEX_VAULT_KEY_FILE } from '../config/paths.js';
import { childEnv } from '../secrets/sanitize.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { withLock } from '../utils/file-lock.js';
import { VAULT_KEYSTORE_BASENAME, VAULT_KEY_DPAPI_BASENAME } from './paths.js';

export type KeyBackendName = 'file' | 'macos' | 'secret-service' | 'windows';
export const KEY_BACKENDS: readonly KeyBackendName[] = ['file', 'macos', 'secret-service', 'windows'];

/** Keychain service name of the vault key item. */
export const KEYCHAIN_SERVICE = 'qodex-vault-key';

const BACKEND_LABEL: Record<KeyBackendName, string> = {
  file: 'key file',
  macos: 'macOS Keychain',
  'secret-service': 'Secret Service (GNOME Keyring / KWallet)',
  windows: 'Windows DPAPI',
};

export function keyBackendLabel(name: KeyBackendName): string {
  return BACKEND_LABEL[name] ?? name;
}

export function isKeyBackendName(s: string): s is KeyBackendName {
  return (KEY_BACKENDS as readonly string[]).includes(s);
}

// ── command runner ──────────────────────────────────────────────────────────

export interface RunResult {
  /** Exit code; null when the program could not be started (not installed) or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a program with `input` on stdin. Secrets go on stdin, NEVER in `args`. */
export type CommandRunner = (cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<RunResult>;

const MAX_OUTPUT = 256 * 1024;

/** The real runner: async spawn, sanitized env, stdin input, timeout (default 20 s). */
export const spawnRunner: CommandRunner = (cmd, args, opts = {}) => new Promise((resolve) => {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cmd, args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e: any) {
    resolve({ code: null, stdout: '', stderr: String(e?.code ?? 'spawn failed') });
    return;
  }
  let stdout = '';
  let stderr = '';
  let done = false;
  const finish = (r: RunResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    finish({ code: null, stdout: '', stderr: 'timed out' });
  }, opts.timeoutMs ?? 20_000);
  child.stdout?.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf-8'); });
  child.stderr?.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf-8'); });
  child.on('error', (e: any) => finish({ code: null, stdout: '', stderr: String(e?.code ?? 'error') }));
  child.on('close', (code) => finish({ code: code ?? null, stdout, stderr }));
  child.stdin?.on('error', () => { /* program exited before reading stdin */ });
  child.stdin?.end(opts.input ?? '');
});

/** First line of a program's stderr with anything key-shaped removed. PURE. */
function stderrLine(r: RunResult, secrets: string[] = []): string {
  let s = String(r.stderr ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
  for (const x of secrets) if (x && x.length >= 8) s = s.split(x).join('***');
  // base64 runs long enough to be a key or a sealed blob never leave this module.
  s = s.replace(/[A-Za-z0-9+/]{24,}={0,2}/g, '***');
  return s.slice(0, 160);
}

// ── backends ────────────────────────────────────────────────────────────────

export interface KeyBackend {
  readonly name: KeyBackendName;
  /** null when usable here, else why not. */
  available(): Promise<string | null>;
  /** The stored key, or null when this backend holds none. Throws when it cannot be asked. */
  read(): Promise<Buffer | null>;
  /** Store (create or replace) the key. */
  write(key: Buffer): Promise<void>;
  /** Delete the stored key (no-op when absent). */
  erase(): Promise<void>;
  /** Where it lives, for status output (no secret). */
  describe(): string;
}

export interface KeyStoreOptions {
  /** The key file (default QODEX_VAULT_KEY_FILE). The keystore record and the DPAPI blob live next to it. */
  keyFile?: string;
  /** Override the keystore record path. */
  keystoreFile?: string;
  /** Runs `security` / `secret-tool` / `powershell` (tests pass a fake). */
  runner?: CommandRunner;
  /** Platform to assume (tests). */
  platform?: NodeJS.Platform;
  /** Environment to look at for the D-Bus session (tests). */
  env?: NodeJS.ProcessEnv;
}

function decodeKey(text: string, code: string): Buffer {
  const key = Buffer.from(String(text ?? '').trim(), 'base64');
  if (key.length !== 32) throw new Error(`[${code}] the stored vault key is damaged (expected 32 bytes of base64)`);
  return key;
}

function unavailable(label: string, why: string): Error {
  return new Error(`[VAULT_KEYCHAIN_UNAVAILABLE] ${label} could not be used: ${why || 'unknown error'}`);
}

class FileBackend implements KeyBackend {
  readonly name = 'file' as const;
  constructor(private readonly keyFile: string, private readonly platform: NodeJS.Platform, private readonly invalidCode: string) {}
  async available(): Promise<string | null> { return null; }
  describe(): string { return this.keyFile; }
  async read(): Promise<Buffer | null> {
    let text: string;
    try {
      text = await fs.readFile(this.keyFile, 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    const key = decodeKey(text, this.invalidCode);
    if (this.platform !== 'win32') {
      try {
        const st = await fs.stat(this.keyFile);
        if ((st.mode & 0o077) !== 0) await fs.chmod(this.keyFile, 0o600);
      } catch { /* best effort */ }
    }
    return key;
  }
  /** Create only — never overwrites (a race with another process lands on EEXIST). */
  async create(key: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    const fh = await fs.open(this.keyFile, 'wx', 0o600);
    try { await fh.writeFile(key.toString('base64') + '\n'); await fh.sync(); } finally { await fh.close(); }
  }
  async write(key: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.keyFile, key.toString('base64') + '\n', { mode: 0o600 });
  }
  async erase(): Promise<void> {
    try { await fs.unlink(this.keyFile); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
  }
}

class MacKeychainBackend implements KeyBackend {
  readonly name = 'macos' as const;
  constructor(private readonly account: string, private readonly run: CommandRunner, private readonly platform: NodeJS.Platform) {}
  describe(): string { return `login keychain, service "${KEYCHAIN_SERVICE}", account "${this.account}"`; }
  async available(): Promise<string | null> {
    if (this.platform !== 'darwin') return 'only on macOS';
    const r = await this.run('security', ['list-keychains', '-d', 'user'], { timeoutMs: 10_000 });
    if (r.code === null) return 'the `security` tool is not available';
    return r.code === 0 ? null : `security exited with ${r.code} (${stderrLine(r)})`;
  }
  async read(): Promise<Buffer | null> {
    const r = await this.run('security', ['find-generic-password', '-a', this.account, '-s', KEYCHAIN_SERVICE, '-w']);
    if (r.code === 44) return null; // errSecItemNotFound
    if (r.code !== 0) throw unavailable(BACKEND_LABEL.macos, r.code === null ? 'the `security` tool did not run' : `security exited with ${r.code} (${stderrLine(r)}) — is the keychain locked?`);
    return decodeKey(r.stdout, 'VAULT_KEY_INVALID');
  }
  async write(key: Buffer): Promise<void> {
    // `security -i` reads commands from stdin: the key never appears in argv.
    const b64 = key.toString('base64');
    const r = await this.run('security', ['-i'], {
      input: `add-generic-password -U -a ${this.account} -s ${KEYCHAIN_SERVICE} -l "QodeX vault key" -w ${b64}\n`,
    });
    if (r.code !== 0) throw unavailable(BACKEND_LABEL.macos, r.code === null ? 'the `security` tool did not run' : `security exited with ${r.code} (${stderrLine(r, [b64])})`);
  }
  async erase(): Promise<void> {
    const r = await this.run('security', ['delete-generic-password', '-a', this.account, '-s', KEYCHAIN_SERVICE]);
    if (r.code !== 0 && r.code !== 44) throw unavailable(BACKEND_LABEL.macos, `could not delete the keychain item (exit ${r.code})`);
  }
}

class SecretServiceBackend implements KeyBackend {
  readonly name = 'secret-service' as const;
  constructor(private readonly account: string, private readonly run: CommandRunner, private readonly platform: NodeJS.Platform, private readonly env: NodeJS.ProcessEnv) {}
  describe(): string { return `secret service item service=${KEYCHAIN_SERVICE} account=${this.account}`; }
  private attrs(): string[] { return ['service', KEYCHAIN_SERVICE, 'account', this.account]; }
  async available(): Promise<string | null> {
    if (this.platform === 'win32' || this.platform === 'darwin') return 'only on Linux / BSD desktops';
    if (!this.env.DBUS_SESSION_BUS_ADDRESS) return 'no D-Bus session (headless server, container or plain SSH)';
    const r = await this.run('secret-tool', ['search', ...this.attrs()], { timeoutMs: 10_000 });
    if (r.code === null) return 'the `secret-tool` program is not installed (libsecret-tools)';
    // search exits 1 when nothing matches; anything else means the service is not answering.
    return r.code === 0 || r.code === 1 ? null : `secret-tool exited with ${r.code} (${stderrLine(r)})`;
  }
  async read(): Promise<Buffer | null> {
    const r = await this.run('secret-tool', ['lookup', ...this.attrs()]);
    if (r.code === 1 && !r.stdout.trim()) return null;
    if (r.code !== 0) throw unavailable(BACKEND_LABEL['secret-service'], r.code === null ? 'secret-tool did not run' : `secret-tool exited with ${r.code} (${stderrLine(r)}) — is the keyring unlocked?`);
    if (!r.stdout.trim()) return null;
    return decodeKey(r.stdout, 'VAULT_KEY_INVALID');
  }
  async write(key: Buffer): Promise<void> {
    const b64 = key.toString('base64');
    // secret-tool reads the secret from stdin when it is not a terminal.
    const r = await this.run('secret-tool', ['store', '--label=QodeX vault key', ...this.attrs()], { input: b64 });
    if (r.code !== 0) throw unavailable(BACKEND_LABEL['secret-service'], r.code === null ? 'secret-tool did not run' : `secret-tool exited with ${r.code} (${stderrLine(r, [b64])})`);
  }
  async erase(): Promise<void> {
    const r = await this.run('secret-tool', ['clear', ...this.attrs()]);
    if (r.code !== 0 && r.code !== 1) throw unavailable(BACKEND_LABEL['secret-service'], `could not delete the item (exit ${r.code})`);
  }
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-'];

class WindowsDpapiBackend implements KeyBackend {
  readonly name = 'windows' as const;
  constructor(private readonly blobFile: string, private readonly run: CommandRunner, private readonly platform: NodeJS.Platform) {}
  describe(): string { return `${this.blobFile} (sealed with DPAPI for the current Windows user)`; }
  async available(): Promise<string | null> {
    if (this.platform !== 'win32') return 'only on Windows';
    const r = await this.run('powershell.exe', PS_ARGS, { input: 'Add-Type -AssemblyName System.Security\n"dpapi-ok"\n', timeoutMs: 30_000 });
    if (r.code === null) return 'PowerShell is not available';
    return r.code === 0 && r.stdout.includes('dpapi-ok') ? null : `PowerShell exited with ${r.code} (${stderrLine(r)})`;
  }
  /** Run a DPAPI transform with the base64 input inside the script on stdin. */
  private async transform(op: 'Protect' | 'Unprotect', b64: string): Promise<string> {
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      `$in = [Convert]::FromBase64String('${b64}')`,
      `$out = [System.Security.Cryptography.ProtectedData]::${op}($in, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
      '[Convert]::ToBase64String($out)',
      '',
    ].join('\n');
    const r = await this.run('powershell.exe', PS_ARGS, { input: script, timeoutMs: 30_000 });
    if (r.code !== 0) throw unavailable(BACKEND_LABEL.windows, r.code === null ? 'PowerShell did not run' : `DPAPI ${op} failed (exit ${r.code}: ${stderrLine(r, [b64])})`);
    return r.stdout.trim();
  }
  async read(): Promise<Buffer | null> {
    let blob: string;
    try {
      blob = (await fs.readFile(this.blobFile, 'utf-8')).trim();
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(blob)) throw new Error('[VAULT_KEY_INVALID] the DPAPI-sealed vault key is damaged');
    return decodeKey(await this.transform('Unprotect', blob), 'VAULT_KEY_INVALID');
  }
  async write(key: Buffer): Promise<void> {
    const sealed = await this.transform('Protect', key.toString('base64'));
    if (!/^[A-Za-z0-9+/=]{16,}$/.test(sealed)) throw unavailable(BACKEND_LABEL.windows, 'DPAPI returned no data');
    await fs.mkdir(path.dirname(this.blobFile), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.blobFile, sealed + '\n', { mode: 0o600 });
  }
  async erase(): Promise<void> {
    try { await fs.unlink(this.blobFile); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
  }
}

// ── the record ──────────────────────────────────────────────────────────────

export interface KeystoreRecord {
  format: 'qodex-vault-keystore';
  version: 1;
  backend: KeyBackendName;
  /** HMAC of the key (identifies it without revealing it). */
  fingerprint: string;
  createdAt: string;
  updatedAt?: string;
}

/** A one-way identifier of a key: HMAC-SHA256(key, label), 16 hex chars. PURE. */
export function keyFingerprint(key: Buffer): string {
  return createHmac('sha256', key).update('qodex-vault-key-fingerprint:v1').digest('hex').slice(0, 16);
}

type CodePrefix = 'VAULT' | 'MAIL';

export interface KeyLoadOptions {
  /** Mint a key when this is a fresh install. */
  create?: boolean;
  /** Files encrypted / signed with the key: if any exists, a missing key is never re-minted. */
  guardFiles?: string[];
  /** Error code prefix: 'VAULT' (default) or 'MAIL'. */
  codePrefix?: CodePrefix;
}

export interface KeyStatus {
  backend: KeyBackendName;
  /** A keystore record exists (false = legacy / fresh install using the key file). */
  recorded: boolean;
  /** The key is where the record says. */
  present: boolean;
  /** The stored key matches the recorded fingerprint (undefined when unknown). */
  fingerprintOk?: boolean;
  /** Where it lives (no secret). */
  location: string;
  /** Why the recorded backend could not be read, if it could not. */
  error?: string;
  /** Every backend and whether it can be used here (null = usable). */
  backends: Array<{ name: KeyBackendName; label: string; unavailable: string | null }>;
}

export interface MigrateResult {
  from: KeyBackendName;
  to: KeyBackendName;
  changed: boolean;
  /** A key was created because none existed yet. */
  minted: boolean;
  warnings: string[];
}

/** Process-wide cache for keychain backends (one `security` / PowerShell call per process). */
const keyCache = new Map<string, { backend: KeyBackendName; fingerprint: string; key: Buffer }>();

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

export class VaultKeyStore {
  readonly keyFile: string;
  readonly keystoreFile: string;
  readonly dpapiFile: string;
  /** Keychain account: unique per key file path, so two QodeX homes never share an item. */
  readonly account: string;
  private readonly run: CommandRunner;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: KeyStoreOptions = {}) {
    this.keyFile = path.resolve(opts.keyFile ?? QODEX_VAULT_KEY_FILE);
    const dir = path.dirname(this.keyFile);
    // ~/.qodex/.vault-key → ~/.qodex/vault-keystore.json + .vault-key.dpapi; any other key
    // file (tests, a custom location) gets its own record beside it, never a shared one.
    const standard = path.basename(this.keyFile) === '.vault-key';
    this.keystoreFile = path.resolve(opts.keystoreFile ?? (standard ? path.join(dir, VAULT_KEYSTORE_BASENAME) : this.keyFile + '.keystore.json'));
    this.dpapiFile = standard ? path.join(dir, VAULT_KEY_DPAPI_BASENAME) : this.keyFile + '.dpapi';
    this.account = 'qodex-' + createHash('sha256').update(this.keyFile).digest('hex').slice(0, 12);
    this.run = opts.runner ?? spawnRunner;
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
  }

  backend(name: KeyBackendName): KeyBackend {
    switch (name) {
      case 'file': return this.fileBackend();
      case 'macos': return new MacKeychainBackend(this.account, this.run, this.platform);
      case 'secret-service': return new SecretServiceBackend(this.account, this.run, this.platform, this.env);
      case 'windows': return new WindowsDpapiBackend(this.dpapiFile, this.run, this.platform);
    }
    throw new Error(`[VAULT_INVALID] unknown key backend "${String(name).slice(0, 30)}"`);
  }

  private fileBackend(prefix: CodePrefix = 'VAULT'): FileBackend {
    return new FileBackend(this.keyFile, this.platform, `${prefix}_KEY_INVALID`);
  }

  /** The OS keychain this platform has, if any. PURE. */
  nativeBackend(): KeyBackendName | null {
    if (this.platform === 'darwin') return 'macos';
    if (this.platform === 'win32') return 'windows';
    if (this.platform === 'linux' || this.platform === 'freebsd' || this.platform === 'openbsd') return 'secret-service';
    return null;
  }

  private lockPath(): string {
    return this.keystoreFile + '.lock';
  }

  private cacheKey(): string {
    return this.keystoreFile;
  }

  /** The keystore record, or null when there is none. Throws on a damaged record. */
  async record(): Promise<KeystoreRecord | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.keystoreFile, 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    let rec: Partial<KeystoreRecord>;
    try { rec = JSON.parse(raw); } catch { throw new Error(`[VAULT_KEYSTORE_CORRUPT] ${this.keystoreFile} is not valid JSON — restore it (it says where the vault key is kept)`); }
    if (rec?.format !== 'qodex-vault-keystore' || rec.version !== 1 || !rec.backend || !isKeyBackendName(rec.backend)) {
      throw new Error(`[VAULT_KEYSTORE_CORRUPT] ${this.keystoreFile} has an unknown format`);
    }
    return { format: 'qodex-vault-keystore', version: 1, backend: rec.backend, fingerprint: String(rec.fingerprint ?? ''), createdAt: String(rec.createdAt ?? ''), updatedAt: rec.updatedAt };
  }

  private async writeRecord(backend: KeyBackendName, key: Buffer, prev: KeystoreRecord | null): Promise<void> {
    const now = new Date().toISOString();
    const rec: KeystoreRecord = {
      format: 'qodex-vault-keystore', version: 1, backend, fingerprint: keyFingerprint(key),
      createdAt: prev?.createdAt || now, ...(prev ? { updatedAt: now } : {}),
    };
    await fs.mkdir(path.dirname(this.keystoreFile), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.keystoreFile, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  }

  private missing(prefix: CodePrefix, detail: string): Error {
    return new Error(`[${prefix}_KEY_MISSING] ${detail}`);
  }

  /** Load the key from the recorded backend; mint one (file backend) only on a fresh install. */
  async load(opts: KeyLoadOptions = {}): Promise<Buffer | null> {
    const prefix = opts.codePrefix ?? 'VAULT';
    const rec = await this.record();
    if (rec) return this.loadRecorded(rec, prefix);

    // No record: a legacy install (key file only) or a fresh one.
    const file = this.fileBackend(prefix);
    const key = await file.read();
    if (key) {
      // Remember the backend from now on (write paths only — reads never create files).
      if (opts.create) await this.writeRecord('file', key, null).catch(() => {});
      return key;
    }
    for (const f of opts.guardFiles ?? []) {
      if (await fileExists(f)) {
        throw this.missing(prefix, `${f} exists but its key file ${this.keyFile} is missing — restore the key file, or delete the encrypted files to start over`);
      }
    }
    if (!opts.create) return null;
    return withLock(this.lockPath(), async () => {
      // Another process may have minted or migrated while we waited.
      const again = await this.record();
      if (again) return this.loadRecorded(again, prefix);
      const existing = await file.read();
      if (existing) {
        await this.writeRecord('file', existing, null).catch(() => {});
        return existing;
      }
      const fresh = randomBytes(32);
      try {
        await file.create(fresh);
      } catch (e: any) {
        if (e?.code === 'EEXIST') {
          const k = await file.read();
          if (k) return k;
        }
        throw e;
      }
      await this.writeRecord('file', fresh, null);
      return fresh;
    });
  }

  private async loadRecorded(rec: KeystoreRecord, prefix: CodePrefix): Promise<Buffer> {
    const cached = keyCache.get(this.cacheKey());
    if (rec.backend !== 'file' && cached && cached.backend === rec.backend && cached.fingerprint === rec.fingerprint) return cached.key;
    const be = rec.backend === 'file' ? this.fileBackend(prefix) : this.backend(rec.backend);
    const key = await be.read();
    if (!key) {
      throw this.missing(prefix, rec.backend === 'file'
        ? `the vault key file ${this.keyFile} is missing (${this.keystoreFile} records that the key is kept there) — restore it from a backup; a new key would not open existing data`
        : `the vault key is not in the ${BACKEND_LABEL[rec.backend]} (${be.describe()}) although ${this.keystoreFile} records it there — restore the keychain item; a new key would not open existing data`);
    }
    if (rec.backend !== 'file' && rec.fingerprint && keyFingerprint(key) !== rec.fingerprint) {
      throw new Error(`[VAULT_KEY_MISMATCH] the key in the ${BACKEND_LABEL[rec.backend]} is not the one recorded in ${this.keystoreFile}`);
    }
    if (rec.backend !== 'file') keyCache.set(this.cacheKey(), { backend: rec.backend, fingerprint: rec.fingerprint, key });
    return key;
  }

  /** Where the key is and whether it is there. Never returns key material. */
  async status(): Promise<KeyStatus> {
    const backends = await Promise.all(KEY_BACKENDS.map(async (name) => ({
      name, label: BACKEND_LABEL[name], unavailable: await this.backend(name).available().catch((e: any) => String(e?.message ?? e).slice(0, 120)),
    })));
    let rec: KeystoreRecord | null = null;
    try { rec = await this.record(); } catch (e: any) {
      return { backend: 'file', recorded: true, present: false, location: this.keystoreFile, error: String(e?.message ?? e), backends };
    }
    const name = rec?.backend ?? 'file';
    const be = this.backend(name);
    try {
      const key = await be.read();
      return {
        backend: name, recorded: !!rec, present: !!key, location: be.describe(), backends,
        fingerprintOk: key && rec?.fingerprint ? keyFingerprint(key) === rec.fingerprint : undefined,
      };
    } catch (e: any) {
      return { backend: name, recorded: !!rec, present: false, location: be.describe(), error: String(e?.message ?? e).split('\n')[0].slice(0, 200), backends };
    }
  }

  /**
   * Move the key to `target`: store it there, read it back and compare (constant time),
   * record the new backend, then delete the old copy. `verify(key)` runs first (e.g. a
   * test decryption of the vault) so a wrong key is never migrated. On a fresh install a
   * new key is created directly in `target`.
   */
  async migrate(target: KeyBackendName, opts: { guardFiles?: string[]; verify?: (key: Buffer) => Promise<void> } = {}): Promise<MigrateResult> {
    if (!isKeyBackendName(target)) throw new Error(`[VAULT_INVALID] unknown key backend "${String(target).slice(0, 30)}" — use ${KEY_BACKENDS.join(', ')}`);
    return withLock(this.lockPath(), async () => {
      const rec = await this.record();
      const from: KeyBackendName = rec?.backend ?? 'file';
      let key: Buffer | null;
      if (rec) key = await this.loadRecorded(rec, 'VAULT');
      else {
        key = await this.fileBackend().read();
        if (!key) {
          for (const f of opts.guardFiles ?? []) {
            if (await fileExists(f)) throw this.missing('VAULT', `${f} exists but its key file ${this.keyFile} is missing — nothing to migrate`);
          }
        }
      }
      const warnings: string[] = [];
      if (from === target && key) {
        if (!rec) await this.writeRecord(target, key, null);
        return { from, to: target, changed: false, minted: false, warnings };
      }
      const why = await this.backend(target).available();
      if (why) throw unavailable(BACKEND_LABEL[target], why);
      const minted = !key;
      const theKey = key ?? randomBytes(32);
      if (!minted && opts.verify) await opts.verify(theKey);

      const dest = this.backend(target);
      await dest.write(theKey);
      let back: Buffer | null = null;
      try { back = await dest.read(); } catch { back = null; }
      if (!back || back.length !== theKey.length || !timingSafeEqual(back, theKey)) {
        throw new Error(`[VAULT_KEY_MIGRATE_FAILED] the ${BACKEND_LABEL[target]} did not return the same key after storing it — nothing was changed; the key is still in the ${BACKEND_LABEL[from]}`);
      }
      await this.writeRecord(target, theKey, rec);
      keyCache.delete(this.cacheKey());
      if (from !== target && !minted) {
        try {
          await this.backend(from).erase();
        } catch (e: any) {
          warnings.push(`could not delete the old copy in the ${BACKEND_LABEL[from]} (${String(e?.message ?? e).split('\n')[0].slice(0, 120)}) — delete it yourself`);
        }
      }
      return { from, to: target, changed: true, minted, warnings };
    });
  }
}

// ── the shared loader ───────────────────────────────────────────────────────

let testDefaults: Pick<KeyStoreOptions, 'runner' | 'platform' | 'env'> | null = null;

/** Test hook: the runner / platform / env stores created by getVaultKey use (null = real). */
export function setKeyStoreDefaultsForTests(d: Pick<KeyStoreOptions, 'runner' | 'platform' | 'env'> | null): void {
  testDefaults = d;
  keyCache.clear();
}

/** Drop cached keychain keys (tests; after an external migration). */
export function clearVaultKeyCache(): void {
  keyCache.clear();
}

/** A keystore for `keyFile` (default QODEX_VAULT_KEY_FILE). */
export function vaultKeyStore(opts: KeyStoreOptions = {}): VaultKeyStore {
  return new VaultKeyStore({ ...(testDefaults ?? {}), ...opts });
}

export interface GetVaultKeyOptions extends KeyLoadOptions {
  keyFile?: string;
  /** The vault file (default QODEX_VAULT_FILE): always a guard file. */
  vaultFile?: string;
}

/**
 * THE vault key, for the vault, the mail accounts file and the mail drafts signer.
 * Null only when there is none yet and `create` is false.
 */
export async function getVaultKey(opts: GetVaultKeyOptions = {}): Promise<Buffer | null> {
  const store = vaultKeyStore({ keyFile: opts.keyFile });
  const guardFiles = [opts.vaultFile ?? QODEX_VAULT_FILE, ...(opts.guardFiles ?? [])];
  return store.load({ create: opts.create, guardFiles, codePrefix: opts.codePrefix });
}
