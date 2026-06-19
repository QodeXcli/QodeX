/**
 * Redact values for keys that commonly hold secrets.
 * Used in permission prompts and log lines so we don't leak API keys, tokens, passwords,
 * etc. into the terminal scrollback or qodex.log.
 */
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|token|password|passwd|secret|authorization|auth(?!or)|access[_-]?key|private[_-]?key|client[_-]?secret|bearer|x[_-]api[_-]key|session[_-]?id)/i;

export function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    if (typeof value === 'string' && value.length > 0) {
      // Keep first 2 chars so the user knows something is set, redact the rest
      const visible = value.slice(0, 2);
      return `${visible}***[redacted ${value.length} chars]`;
    }
    return '[redacted]';
  }
  return value;
}

export function redactObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k)
        ? '[redacted nested object]'
        : redactObject(v as Record<string, unknown>);
    } else {
      out[k] = redactValue(k, v);
    }
  }
  return out;
}
