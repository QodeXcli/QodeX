/**
 * Subprocess environment sanitization.
 *
 * The agent spawns child processes the MODEL chose — arbitrary shell commands, test runners,
 * dev servers, linters. Every one of them used to inherit the full parent environment, which
 * includes the provider API keys QodeX itself authenticates with (`env: { ...process.env }`
 * in the shell tool). A single `env`, a curl to a paste site, or a compromised dev dependency
 * in a repo the agent is working on would exfiltrate them.
 *
 * That is the sharpest contradiction with the product's own pitch — "trust this to run
 * unattended in your repo" — so secrets are stripped from child environments BY DEFAULT, and
 * a child that genuinely needs one has to say so explicitly.
 *
 * Design notes:
 *   - Default-deny for anything that looks like a credential, not an allowlist of known keys:
 *     a user's own `MY_COMPANY_TOKEN` deserves the same protection as ANTHROPIC_API_KEY.
 *   - Non-secret variables (PATH, HOME, LANG, NODE_ENV, …) pass through untouched, so nothing
 *     breaks — this is a filter, not a jail.
 *   - PURE and dependency-free so it is trivially testable and callable from any spawn site.
 */

/**
 * Name patterns that mark a variable as credential-bearing. Deliberately broad: a false
 * positive costs a child process one variable it probably did not need, a false negative
 * leaks a key.
 */
const SECRET_NAME_PATTERNS: RegExp[] = [
  /API[_-]?KEY$/i,
  /(^|_)KEY$/i,
  /TOKEN$/i,
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /(^|_)AUTH$/i,
  /SESSION[_-]?ID$/i,
  /PRIVATE[_-]?KEY/i,
  /ACCESS[_-]?KEY/i,
];

/**
 * Variables that match a pattern above but are NOT secrets and are load-bearing for child
 * processes. Without these, ordinary commands break for no security gain.
 */
const NEVER_SECRET = new Set([
  'SSH_AUTH_SOCK',   // a socket path, not a key — stripping it breaks git over SSH
  'GPG_TTY',
  'KEYMAP',
  'XDG_SESSION_ID',
  'DBUS_SESSION_BUS_ADDRESS',
  'HOSTNAME',
]);

/** Explicit names we always treat as secret regardless of shape. */
const ALWAYS_SECRET = new Set([
  'QODEX_AUDIT_KEY',       // signs run receipts — a leak forges proof
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'TAVILY_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'FIRECRAWL_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

/** True when this variable NAME should be treated as credential-bearing. PURE. */
export function isSecretName(name: string): boolean {
  if (!name) return false;
  if (NEVER_SECRET.has(name)) return false;
  if (ALWAYS_SECRET.has(name)) return true;
  return SECRET_NAME_PATTERNS.some(re => re.test(name));
}

export interface SanitizeOptions {
  /**
   * Variable names the child is explicitly allowed to receive. This is the escape hatch for
   * the rare legitimate case (a test suite that needs its own API key). Callers should pass
   * the narrowest possible list — never the whole environment.
   */
  allow?: readonly string[];
  /** Extra names to treat as secret on top of the built-in rules (e.g. from config). */
  extraSecretNames?: readonly string[];
}

export interface SanitizeResult {
  env: Record<string, string>;
  /** Names that were removed — for logging/telemetry. NEVER contains values. */
  stripped: string[];
  /** Names that matched a secret rule but were explicitly allowed through. */
  allowed: string[];
}

/**
 * Build a child environment with credential-bearing variables removed. PURE.
 *
 * Returns the names stripped (not their values) so a caller can log what happened without
 * writing a secret to disk.
 */
export function sanitizeEnv(
  base: NodeJS.ProcessEnv | Record<string, string | undefined>,
  opts: SanitizeOptions = {},
): SanitizeResult {
  const allow = new Set(opts.allow ?? []);
  const extra = new Set(opts.extraSecretNames ?? []);
  const env: Record<string, string> = {};
  const stripped: string[] = [];
  const allowed: string[] = [];

  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const secret = isSecretName(name) || extra.has(name);
    if (!secret) { env[name] = value; continue; }
    if (allow.has(name)) { env[name] = value; allowed.push(name); continue; }
    stripped.push(name);
  }

  stripped.sort();
  allowed.sort();
  return { env, stripped, allowed };
}

/**
 * The common call: a sanitized copy of `process.env` plus any overrides the caller wants.
 * Overrides are applied AFTER sanitization, so a caller can deliberately inject a value
 * (that is an explicit decision, unlike silent inheritance).
 */
export function childEnv(
  overrides: Record<string, string> = {},
  opts: SanitizeOptions = {},
): Record<string, string> {
  const { env } = sanitizeEnv(process.env, opts);
  return { ...env, ...overrides };
}
