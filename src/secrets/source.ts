/**
 * Pluggable secret sources.
 *
 * Today every provider key lives in plaintext in `~/.qodex/.env`. That file is the whole
 * credential store, it sits on disk unencrypted, and it is the thing an unattended agent
 * runs next to. A user who already keeps secrets in their OS keychain or a password manager
 * should not have to copy them into a dotfile to use QodeX.
 *
 * A source resolves a REFERENCE to a value. References are opaque strings whose shape tells
 * the resolver which source owns them:
 *   - `op://vault/item/field`  → 1Password CLI
 *   - `keychain://service`     → macOS Keychain
 *   - anything else            → the environment (the existing behaviour, still the default)
 *
 * Two rules this module will not bend:
 *   1. A source that cannot answer says so — it NEVER falls through to a different value.
 *      Silently substituting the wrong credential is worse than failing to start.
 *   2. Values are never logged, echoed, or stored. Only names and provenance travel.
 */
import { spawnSync } from 'child_process';

export type SecretSourceName = 'env' | 'keychain' | '1password';

export interface SecretLookup {
  /** The resolved value, or undefined when this source has no answer. */
  value?: string;
  /** True when the backing tool itself is unavailable (CLI missing, wrong OS). */
  unavailable?: boolean;
  /** Why it was unavailable or empty. Safe to log — never contains a value. */
  reason?: string;
}

export interface SecretSource {
  name: SecretSourceName;
  /** True when this source claims the reference shape. */
  handles(ref: string): boolean;
  get(ref: string): SecretLookup;
  /** Human description of a reference, for provenance output. NEVER the value. */
  describe(ref: string): string;
}

/** Run a CLI and return stdout, or a reason it could not. Never throws. */
function runTool(cmd: string, args: string[], timeoutMs = 10_000): { out?: string; reason?: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: timeoutMs });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      return { reason: code === 'ENOENT' ? `\`${cmd}\` is not installed or not on PATH` : `\`${cmd}\` failed: ${r.error.message}` };
    }
    if (r.status !== 0) {
      // stderr can echo the item path but not the value — safe to surface, trimmed.
      return { reason: `\`${cmd}\` exited ${r.status}: ${(r.stderr ?? '').trim().slice(0, 200)}` };
    }
    const out = (r.stdout ?? '').replace(/\n$/, '');
    return out ? { out } : { reason: `\`${cmd}\` returned an empty value` };
  } catch (e: any) {
    return { reason: `\`${cmd}\` could not be run: ${e?.message}` };
  }
}

export const envSource: SecretSource = {
  name: 'env',
  handles: () => true, // the fallback — claims anything the others did not
  get(ref) {
    const value = process.env[ref];
    return value ? { value } : { reason: `environment variable ${ref} is not set` };
  },
  describe: ref => `env:${ref}`,
};

export const keychainSource: SecretSource = {
  name: 'keychain',
  handles: ref => ref.startsWith('keychain://'),
  get(ref) {
    if (process.platform !== 'darwin') {
      return { unavailable: true, reason: 'the macOS Keychain is only available on macOS' };
    }
    const service = ref.slice('keychain://'.length);
    if (!service) return { reason: 'keychain reference is missing a service name' };
    const r = runTool('security', ['find-generic-password', '-s', service, '-w']);
    if (r.out) return { value: r.out };
    // `security` exits non-zero both when it is missing and when the item is absent;
    // distinguish so the user is told the actionable thing.
    const missingTool = (r.reason ?? '').includes('not installed');
    return { unavailable: missingTool, reason: r.reason };
  },
  describe: ref => `keychain:${ref.slice('keychain://'.length)}`,
};

export const onePasswordSource: SecretSource = {
  name: '1password',
  handles: ref => ref.startsWith('op://'),
  get(ref) {
    const r = runTool('op', ['read', ref]);
    if (r.out) return { value: r.out };
    const missingTool = (r.reason ?? '').includes('not installed');
    return { unavailable: missingTool, reason: r.reason };
  },
  // The reference itself names a vault/item, not a value — safe to show.
  describe: ref => `1password:${ref}`,
};

/** Ordered: the specific sources claim their shapes, env catches the rest. */
export const DEFAULT_SOURCES: SecretSource[] = [onePasswordSource, keychainSource, envSource];

export interface ResolvedSecret {
  name: string;
  /** Present only on success. Callers must not log this. */
  value?: string;
  source: SecretSourceName | null;
  /** Safe-to-log description of where it came from, e.g. `1password:op://Private/OpenAI/key`. */
  provenance: string;
  ok: boolean;
  reason?: string;
}

/**
 * Resolve one reference through the first source that claims it. Deterministic: the same
 * reference always goes to the same source, so provenance is stable and explicable.
 */
export function resolveSecret(
  name: string,
  ref: string,
  sources: readonly SecretSource[] = DEFAULT_SOURCES,
): ResolvedSecret {
  const source = sources.find(s => s.handles(ref));
  if (!source) {
    return { name, source: null, provenance: 'unresolved', ok: false, reason: `no source handles "${ref}"` };
  }
  const got = source.get(ref);
  if (got.value) {
    return { name, value: got.value, source: source.name, provenance: source.describe(ref), ok: true };
  }
  // Honest failure: we do NOT try the next source. Falling through to a different store is
  // how a run silently authenticates as the wrong identity.
  return {
    name,
    source: source.name,
    provenance: source.describe(ref),
    ok: false,
    reason: got.unavailable ? `${source.name} unavailable — ${got.reason}` : got.reason,
  };
}

/**
 * Resolve a map of `NAME → reference`. Returns results in input order with provenance for
 * each, so `qodex` can print WHERE every credential came from without printing any of them.
 */
export function resolveAll(
  refs: Record<string, string>,
  sources: readonly SecretSource[] = DEFAULT_SOURCES,
): ResolvedSecret[] {
  return Object.entries(refs).map(([name, ref]) => resolveSecret(name, ref, sources));
}

/** Render provenance for humans. Contains names and sources only — never values. PURE. */
export function formatProvenance(resolved: readonly ResolvedSecret[]): string {
  if (!resolved.length) return 'No managed secrets configured.';
  return resolved
    .map(r => `${r.ok ? '✓' : '✗'} ${r.name.padEnd(24)} ${r.provenance}${r.ok ? '' : `  — ${r.reason ?? 'unresolved'}`}`)
    .join('\n');
}
