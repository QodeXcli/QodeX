/**
 * Secret redaction — one place that scrubs credential VALUES from anything we write out.
 *
 * The agent's output goes to a terminal, a log file, a run report, a signed receipt, and
 * (in headless JSON mode) to whatever consumes stdout. A tool that echoes `env`, a stack
 * trace carrying a URL with an embedded token, or a curl command the model wrote all put a
 * live credential on that path. Redacting at the sink is the last line of defence behind
 * `sanitizeEnv` — it catches values that reached the process legitimately and are now on
 * their way somewhere they should not go.
 *
 * PURE and allocation-light: this runs on every tool result, so it must be cheap.
 */
import { isSecretName } from './sanitize.js';

/** Shortest value worth redacting. Below this, a "secret" is noise and would mangle output. */
const MIN_REDACTABLE = 8;

export const REDACTED = '[REDACTED]';

/**
 * Collect the secret VALUES currently in the environment. These are what we scrub for.
 * Short values are skipped: redacting a 3-character token would corrupt unrelated text.
 */
export function secretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_REDACTABLE) continue;
    if (isSecretName(name)) out.push(value);
  }
  // Longest first so a value that contains another is replaced whole rather than in pieces.
  return out.sort((a, b) => b.length - a.length);
}

/** Escape a literal for use inside a RegExp. PURE. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every occurrence of each secret value with `[REDACTED]`. PURE.
 *
 * Values are matched literally (not by pattern), so this cannot over-redact: only strings
 * that ARE a live secret are touched.
 */
export function redactValues(text: string, values: readonly string[]): string {
  if (!text) return text;
  let out = text;
  for (const v of values) {
    if (!v || v.length < MIN_REDACTABLE) continue;
    if (!out.includes(v)) continue; // cheap guard — most text contains no secret at all
    out = out.replace(new RegExp(escapeRe(v), 'g'), REDACTED);
  }
  return out;
}

/** The common call: redact against whatever secrets are in the current environment. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return redactValues(text, secretValuesFromEnv(env));
}

/**
 * Redact recursively through a JSON-able structure (tool results, receipts, reports).
 * Object KEYS are left alone — a key named `api_key` is not itself a secret, and renaming
 * keys would break consumers. Only string values are scrubbed.
 */
export function redactDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const values = secretValuesFromEnv(env);
  if (!values.length) return value;
  const walk = (v: any): any => {
    if (typeof v === 'string') return redactValues(v, values);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}
