/**
 * Expand environment variable references inside a string.
 *
 * Supports three syntaxes:
 *   - $VAR_NAME       — bare reference (chars: A-Z, 0-9, underscore, must start with letter or _)
 *   - ${VAR_NAME}     — braced reference (allows the same characters, with explicit boundaries)
 *   - $$              — literal dollar sign (escape)
 *
 * Unset variables expand to empty string (matching POSIX sh behaviour).
 *
 * Critical for MCP server configs where users write things like:
 *   Authorization: "Bearer $GITHUB_TOKEN"
 *   X-Org: "${TENANT_ID}-prod"
 *
 * History: v0.3.0 had a buggy implementation that only matched `value === '$VAR'`.
 * This caused `Bearer $TOKEN` headers to be passed verbatim, breaking auth.
 * Tests in test/fixes-v0.2.1.test.ts MUST exercise this exact function (not an inline copy)
 * to prevent the bug from silently regressing during refactors.
 */
export function expandEnvString(s: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\$\$/g, '\u0000DOLLAR\u0000')                              // escape $$ temporarily
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => env[name] ?? '')
    .replace(/\u0000DOLLAR\u0000/g, '$');
}

/** Apply expandEnvString to every value in a string-keyed map. */
export function expandEnvObject(
  obj: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? expandEnvString(v, env) : v;
  }
  return out;
}
