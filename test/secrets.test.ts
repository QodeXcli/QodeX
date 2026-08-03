import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { sanitizeEnv, childEnv, isSecretName } from '../src/secrets/sanitize.js';
import { redact, redactDeep, redactValues, secretValuesFromEnv, REDACTED } from '../src/secrets/redact.js';
import {
  resolveSecret, resolveAll, formatProvenance, envSource, keychainSource, onePasswordSource,
  type SecretSource,
} from '../src/secrets/source.js';

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('isSecretName', () => {
  it('flags credential-shaped names', () => {
    for (const n of [
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'QODEX_AUDIT_KEY', 'GITHUB_TOKEN',
      'MY_COMPANY_TOKEN', 'DB_PASSWORD', 'STRIPE_SECRET', 'AWS_SECRET_ACCESS_KEY',
      'SOME_PRIVATE_KEY', 'X_CREDENTIALS',
    ]) expect(isSecretName(n), n).toBe(true);
  });

  it('leaves ordinary variables alone', () => {
    for (const n of ['PATH', 'HOME', 'LANG', 'NODE_ENV', 'TERM', 'PWD', 'SHELL', 'CI'])
      expect(isSecretName(n), n).toBe(false);
  });

  it('does not strip load-bearing variables that merely look secret', () => {
    // SSH_AUTH_SOCK is a socket path — stripping it silently breaks git over SSH.
    expect(isSecretName('SSH_AUTH_SOCK')).toBe(false);
    expect(isSecretName('GPG_TTY')).toBe(false);
  });
});

describe('sanitizeEnv', () => {
  it('removes secrets and keeps everything else', () => {
    const r = sanitizeEnv({ PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_API_KEY: 'sk-live', DB_PASSWORD: 'hunter2' });
    expect(r.env.PATH).toBe('/usr/bin');
    expect(r.env.HOME).toBe('/home/u');
    expect(r.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(r.env.DB_PASSWORD).toBeUndefined();
    expect(r.stripped).toEqual(['ANTHROPIC_API_KEY', 'DB_PASSWORD']);
  });

  it('reports stripped NAMES only — never values', () => {
    const r = sanitizeEnv({ OPENAI_API_KEY: 'sk-super-secret-value' });
    expect(JSON.stringify(r.stripped)).not.toContain('sk-super-secret-value');
    expect(JSON.stringify(r)).not.toContain('sk-super-secret-value');
  });

  it('honours an explicit allowlist — the escape hatch', () => {
    const r = sanitizeEnv(
      { PATH: '/bin', TEST_API_KEY: 'needed', OPENAI_API_KEY: 'not-needed' },
      { allow: ['TEST_API_KEY'] },
    );
    expect(r.env.TEST_API_KEY).toBe('needed');
    expect(r.env.OPENAI_API_KEY).toBeUndefined();
    expect(r.allowed).toEqual(['TEST_API_KEY']);
    expect(r.stripped).toEqual(['OPENAI_API_KEY']);
  });

  it('accepts extra secret names from config', () => {
    const r = sanitizeEnv({ WEIRDLY_NAMED: 'v', PATH: '/bin' }, { extraSecretNames: ['WEIRDLY_NAMED'] });
    expect(r.env.WEIRDLY_NAMED).toBeUndefined();
    expect(r.env.PATH).toBe('/bin');
  });

  it('drops undefined values without crashing', () => {
    expect(() => sanitizeEnv({ A: undefined, B: 'x' })).not.toThrow();
    expect(sanitizeEnv({ A: undefined, B: 'x' }).env).toEqual({ B: 'x' });
  });

  it('childEnv applies overrides AFTER sanitizing (explicit beats implicit)', () => {
    process.env.OPENAI_API_KEY = 'leaky';
    const env = childEnv({ FORCE_COLOR: '0' });
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBeDefined(); // ordinary vars still present — this is a filter, not a jail
  });
});

// The property that actually matters: a real child process must not see the key.
describe('SECURITY: a spawned child cannot read our provider keys', () => {
  it('does not leak an API key into a real subprocess', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leaktest-9f3b7a';
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: childEnv(),
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('sk-ant-leaktest-9f3b7a');
    expect(JSON.parse(r.stdout).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('WOULD have leaked without the fix (proves the test is meaningful)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-leaktest-9f3b7a';
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: { ...process.env }, // the OLD behaviour
      encoding: 'utf-8',
    });
    expect(r.stdout).toContain('sk-ant-leaktest-9f3b7a');
  });

  it('an allowlisted variable does reach the child', () => {
    process.env.TEST_ONLY_API_KEY = 'allowed-value-123';
    process.env.OPENAI_API_KEY = 'blocked-value-456';
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
      env: childEnv({}, { allow: ['TEST_ONLY_API_KEY'] }),
      encoding: 'utf-8',
    });
    const env = JSON.parse(r.stdout);
    expect(env.TEST_ONLY_API_KEY).toBe('allowed-value-123');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('the child still has what it needs to actually run', () => {
    const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(!!process.env.PATH))'], {
      env: childEnv(),
      encoding: 'utf-8',
    });
    expect(r.stdout).toBe('true');
  });
});

describe('redaction', () => {
  it('scrubs a live secret value out of text', () => {
    process.env.OPENAI_API_KEY = 'sk-redact-me-abcdef';
    const out = redact('calling api with sk-redact-me-abcdef now');
    expect(out).not.toContain('sk-redact-me-abcdef');
    expect(out).toContain(REDACTED);
  });

  it('scrubs recursively through objects and arrays', () => {
    process.env.MY_TOKEN = 'tok-deep-secret-1234';
    const out = redactDeep({ a: ['x tok-deep-secret-1234'], b: { c: 'tok-deep-secret-1234' } });
    expect(JSON.stringify(out)).not.toContain('tok-deep-secret-1234');
  });

  it('leaves object KEYS alone — renaming them would break consumers', () => {
    process.env.SOME_TOKEN = 'value-abcdefgh';
    const out: any = redactDeep({ api_key: 'value-abcdefgh' });
    expect(Object.keys(out)).toEqual(['api_key']);
    expect(out.api_key).toBe(REDACTED);
  });

  it('does not redact short values (would corrupt unrelated text)', () => {
    expect(redactValues('the cat sat', ['cat'])).toBe('the cat sat');
  });

  it('collects no values when nothing secret is set', () => {
    const env = { PATH: '/bin', HOME: '/home/u' };
    expect(secretValuesFromEnv(env as any)).toEqual([]);
    expect(redact('nothing to hide', env as any)).toBe('nothing to hide');
  });
});

describe('secret sources', () => {
  it('routes references to the source that claims them', () => {
    expect(onePasswordSource.handles('op://Private/OpenAI/key')).toBe(true);
    expect(keychainSource.handles('keychain://qodex-openai')).toBe(true);
    expect(onePasswordSource.handles('OPENAI_API_KEY')).toBe(false);
    expect(envSource.handles('anything')).toBe(true); // the fallback
  });

  it('resolves from the environment with provenance', () => {
    process.env.MY_PROVIDER_KEY = 'from-env-value';
    const r = resolveSecret('MY_PROVIDER_KEY', 'MY_PROVIDER_KEY');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('from-env-value');
    expect(r.source).toBe('env');
    expect(r.provenance).toBe('env:MY_PROVIDER_KEY');
  });

  it('reports an honest failure instead of falling through to another source', () => {
    // A stub that claims the ref but cannot answer. The resolver must NOT then try env
    // and return a different credential — silently authenticating as the wrong identity
    // is worse than failing.
    process.env.SHADOW = 'wrong-identity-value';
    const failing: SecretSource = {
      name: '1password',
      handles: () => true,
      get: () => ({ unavailable: true, reason: '`op` is not installed or not on PATH' }),
      describe: ref => `1password:${ref}`,
    };
    const r = resolveSecret('SHADOW', 'op://V/I/f', [failing, envSource]);
    expect(r.ok).toBe(false);
    expect(r.value).toBeUndefined();
    expect(r.reason).toMatch(/unavailable/);
    expect(r.reason).toMatch(/not installed/);
  });

  it('reports unresolved when no source claims the reference', () => {
    const r = resolveSecret('X', 'weird://ref', [onePasswordSource, keychainSource]);
    expect(r.ok).toBe(false);
    expect(r.provenance).toBe('unresolved');
  });

  it('a missing env var is a clear reason, not a crash', () => {
    delete process.env.DEFINITELY_NOT_SET_XYZ;
    const r = resolveSecret('DEFINITELY_NOT_SET_XYZ', 'DEFINITELY_NOT_SET_XYZ');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not set/);
  });

  it('formats provenance without ever printing a value', () => {
    process.env.PROV_TEST_KEY = 'super-secret-value-here';
    const out = formatProvenance(resolveAll({ PROV_TEST_KEY: 'PROV_TEST_KEY', MISSING_ONE: 'MISSING_ONE' }));
    expect(out).toContain('PROV_TEST_KEY');
    expect(out).toContain('env:PROV_TEST_KEY');
    expect(out).not.toContain('super-secret-value-here');
    expect(out).toContain('✗'); // the missing one is visibly unresolved
  });

  it('keychain is honestly unavailable off macOS', () => {
    if (process.platform === 'darwin') return; // nothing to assert here
    const r = keychainSource.get('keychain://whatever');
    expect(r.unavailable).toBe(true);
    expect(r.value).toBeUndefined();
  });
});
