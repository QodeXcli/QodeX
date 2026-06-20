/**
 * Key persistence — write API keys to `~/.qodex/.env` so users never have to hand-edit their
 * shell rc to make a provider work.
 *
 * The flow that motivates this: a user runs `qodex provider add groq`, pastes their key, and
 * expects it to just work. Telling them to `echo 'export GROQ_API_KEY=…' >> ~/.zshrc` is exactly
 * the un-friendly step we're removing. Instead we store the key in `~/.qodex/.env` (chmod 600)
 * and load that file at startup, so the key is available to `process.env` without polluting the
 * user's global shell environment or their committed config.yaml.
 *
 * Security posture:
 *   - `~/.qodex/.env` is written 0600 (owner read/write only).
 *   - Keys live OUTSIDE config.yaml, so a user can safely share/commit their config.
 *   - We never log the key value.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_HOME } from '../config/defaults.js';

export const QODEX_ENV_FILE = path.join(QODEX_HOME, '.env');

/** Parse a simple KEY=value env file. Tolerates `export KEY=value`, quotes, blank lines, #comments. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let val = body.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/** Serialize a key→value map back to env-file text (sorted for stable diffs). */
export function serializeEnvFile(vars: Record<string, string>): string {
  const header =
    '# QodeX API keys — loaded automatically at startup.\n' +
    '# Managed by `qodex provider add`. You can edit by hand, one KEY=value per line.\n' +
    '# This file is chmod 600 and is NOT your config.yaml — keep it private, never commit it.\n\n';
  const lines = Object.keys(vars)
    .sort()
    .map(k => `${k}=${vars[k]}`);
  return header + lines.join('\n') + '\n';
}

/** Read the current ~/.qodex/.env into a map (empty if absent/unreadable). */
export async function readEnvFile(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(QODEX_ENV_FILE, 'utf-8');
    return parseEnvFile(raw);
  } catch {
    return {};
  }
}

/**
 * Persist (or update) a single KEY in ~/.qodex/.env without disturbing the others.
 * Returns the path written. The directory is created if needed; the file is chmod 600.
 */
export async function setEnvKey(key: string, value: string): Promise<string> {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error('env key name is required');
  const vars = await readEnvFile();
  vars[trimmedKey] = value;
  await fs.mkdir(QODEX_HOME, { recursive: true });
  await fs.writeFile(QODEX_ENV_FILE, serializeEnvFile(vars), { encoding: 'utf-8', mode: 0o600 });
  try { await fs.chmod(QODEX_ENV_FILE, 0o600); } catch { /* best-effort on platforms without chmod */ }
  return QODEX_ENV_FILE;
}

/**
 * Load ~/.qodex/.env into process.env at startup. Existing process.env values WIN (so an explicit
 * `export FOO=…` in the user's shell still overrides the stored one). Call once during bootstrap,
 * before the router reads any keys. Returns the number of keys loaded.
 */
export async function loadEnvFileIntoProcess(): Promise<number> {
  const vars = await readEnvFile();
  let loaded = 0;
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      loaded++;
    }
  }
  return loaded;
}
