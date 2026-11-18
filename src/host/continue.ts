/**
 * A long job on the host. A rate limit parks it. It is not finished
 * unless the turn says so. A cap stops it instead of running for weeks.
 */
export const DEFAULT_MAX_TURNS = 16;
export const MAX_TURNS_CAP = 48;
export const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;
export const MAX_PAUSES = 40;

export function clampTurns(n: unknown): number {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1) return DEFAULT_MAX_TURNS;
  return Math.min(MAX_TURNS_CAP, v);
}

export function jobDone(text: string): boolean {
  return text.split('\n').some(line => line.trim() === 'JOB_DONE');
}

export function waitForRateLimit(err: unknown): number | null {
  const e = err as { status?: number; statusCode?: number; message?: string; headers?: { get?: (n: string) => string | null } & Record<string, string> };
  const msg = String(e?.message ?? err ?? '');
  const status = e?.status ?? e?.statusCode;
  if (status !== 429 && !/\b429\b|rate.?limit|too many requests/i.test(msg)) return null;
  const raw = e?.headers?.get?.('retry-after') ?? e?.headers?.['retry-after'];
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(MAX_PAUSE_MS, secs * 1000);
  const inMsg = /(\d+)\s*(?:s|sec|seconds)\b/i.exec(msg);
  if (inMsg) return Math.min(MAX_PAUSE_MS, Number(inMsg[1]) * 1000);
  return 15 * 60 * 1000;
}
