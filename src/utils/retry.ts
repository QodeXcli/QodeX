/**
 * Retry with exponential backoff + full jitter.
 *
 * Used to make provider calls resilient to TRANSIENT failures — a busy local
 * inference server (LM Studio mid-model-load returns connection-refused for a
 * second), a cloud 429/503, a socket hangup. Without this, a single blip kills
 * the whole turn; with it, QodeX rides out the bump.
 *
 * Design choices that matter:
 *  - **Only transient errors retry.** A 400 (bad request), 401 (auth), or 404
 *    is permanent — retrying just wastes time and hammers the server. We
 *    classify by status code and error shape and give up immediately on
 *    permanent failures.
 *  - **Full jitter** (AWS Architecture Blog's recommended variant): the sleep
 *    is `random(0, min(cap, base * 2^attempt))`, not the deterministic
 *    `base * 2^attempt`. Deterministic backoff makes many clients retry in
 *    lockstep and re-collide; full jitter spreads them out, which empirically
 *    minimizes total completion time under contention. With a single local
 *    client the jitter is harmless; with a cloud endpoint under load it's the
 *    difference between recovering and thundering-herd.
 *  - **Honors Retry-After.** If the server tells us how long to wait (common on
 *    429), we use that instead of computed backoff — it's authoritative.
 *  - **Abortable.** An AbortSignal cancels both the in-flight wait and further
 *    attempts, so Ctrl-C is instant even mid-backoff.
 */

import { logger } from './logger.js';

export interface RetryOptions {
  /** Max attempts INCLUDING the first. Default 4 (1 try + 3 retries). */
  maxAttempts?: number;
  /** Base delay in ms. Default 400. */
  baseMs?: number;
  /** Cap on any single backoff in ms. Default 8000. */
  capMs?: number;
  signal?: AbortSignal;
  /** Label for logs. */
  label?: string;
  /** Override transient classification (return true → retryable). */
  isRetryable?: (err: unknown) => boolean;
  /**
   * Cap on how long we'll honor a server Retry-After before giving up. A 429
   * from a DAILY token/quota limit can return Retry-After of many minutes
   * (e.g. Groq TPD → ~112 min); blocking the whole turn that long is useless
   * in an interactive CLI. If Retry-After exceeds this, fail fast so the caller
   * can switch model/provider. Default 60000 (60s).
   */
  maxRetryAfterMs?: number;
}

/** Sleep that rejects promptly if the signal aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Pull an HTTP-ish status code out of whatever error shape the SDK/fetch threw. */
export function statusOf(err: any): number | undefined {
  if (err == null) return undefined;
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  // OpenAI SDK nests it
  if (err.error && typeof err.error.status === 'number') return err.error.status;
  return undefined;
}

/** Extract a Retry-After value (seconds) if the server provided one. */
function retryAfterMs(err: any): number | undefined {
  const h = err?.headers ?? err?.response?.headers;
  if (!h) return undefined;
  const raw = typeof h.get === 'function' ? h.get('retry-after') : h['retry-after'];
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

const TRANSIENT_CODE_RE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang ?up|network|fetch failed|terminated|aborted by the server|stream (?:closed|disconnected)|premature close/i;

/** Default transient classifier. */
export function isTransientError(err: any): boolean {
  if (err == null) return false;
  // Never retry a user abort.
  const msg = String(err?.message ?? err);
  if (/\baborted\b/i.test(msg) && !/aborted by the server/i.test(msg)) return false;

  const status = statusOf(err);
  if (status !== undefined) {
    // 408 Request Timeout, 409 Conflict (sometimes transient), 425 Too Early,
    // 429 Too Many Requests, and all 5xx are worth retrying. 5xx EXCEPT 501.
    if (status === 408 || status === 409 || status === 425 || status === 429) return true;
    if (status >= 500 && status !== 501) return true;
    return false; // other 4xx are permanent (400/401/403/404/422…)
  }
  // No status → look at the message/code for network-level signals.
  const code = String(err?.code ?? '');
  return TRANSIENT_CODE_RE.test(msg) || TRANSIENT_CODE_RE.test(code);
}

/**
 * Run `fn`, retrying on transient failures with full-jitter exponential
 * backoff. Throws the last error if all attempts fail (or the error is
 * permanent). The first attempt has attempt index 0.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseMs = opts.baseMs ?? 400;
  const capMs = opts.capMs ?? 8000;
  const retryable = opts.isRetryable ?? isTransientError;
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
  const label = opts.label ?? 'op';

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !retryable(err)) throw err;

      // Compute wait: prefer server's Retry-After, else full-jitter backoff.
      const server = retryAfterMs(err);
      // A Retry-After longer than we're willing to block (e.g. a daily quota
      // 429 asking for many minutes) → fail fast instead of hanging the turn.
      if (server !== undefined && server > maxRetryAfterMs) {
        logger.warn(`Retry ${label}: server Retry-After ${Math.round(server / 1000)}s exceeds cap ${Math.round(maxRetryAfterMs / 1000)}s — giving up (switch model/provider)`, {
          status: statusOf(err),
        });
        throw err;
      }
      const expo = Math.min(capMs, baseMs * 2 ** attempt);
      const wait = server ?? Math.floor(Math.random() * expo);
      logger.warn(`Retry ${label}`, {
        attempt: attempt + 1,
        maxAttempts,
        waitMs: wait,
        status: statusOf(err),
        err: String((err as any)?.message ?? err).slice(0, 160),
      });
      try {
        await abortableSleep(wait, opts.signal);
      } catch {
        throw err; // aborted during backoff → surface the original error
      }
    }
  }
  throw lastErr;
}
