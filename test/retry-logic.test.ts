import { describe, it, expect } from 'vitest';
import { withRetry, isTransientError, statusOf } from '../src/utils/retry.js';

/**
 * Error-handling coverage for src/utils/retry.ts. Focus areas the suite had
 * none of: transient-vs-permanent classification, the control flow of
 * withRetry (no-retry on permanent, retry-then-succeed, exhaustion), abort
 * handling, and null/odd error shapes. Backoff is forced near-zero (baseMs/
 * capMs = 1) so these run instantly.
 */

describe('statusOf — pulls a code out of varied error shapes', () => {
  it('null/undefined → undefined (no throw)', () => {
    expect(statusOf(null)).toBeUndefined();
    expect(statusOf(undefined)).toBeUndefined();
  });
  it('direct .status / .statusCode', () => {
    expect(statusOf({ status: 503 })).toBe(503);
    expect(statusOf({ statusCode: 429 })).toBe(429);
  });
  it('nested response.status and OpenAI-style error.status', () => {
    expect(statusOf({ response: { status: 500 } })).toBe(500);
    expect(statusOf({ error: { status: 401 } })).toBe(401);
  });
});

describe('isTransientError — classification', () => {
  it('null is not transient', () => {
    expect(isTransientError(null)).toBe(false);
  });
  it('retries 408/409/425/429 and 5xx (except 501)', () => {
    for (const s of [408, 409, 425, 429, 500, 502, 503]) {
      expect(isTransientError({ status: s })).toBe(true);
    }
    expect(isTransientError({ status: 501 })).toBe(false);
  });
  it('permanent 4xx are not transient', () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isTransientError({ status: s })).toBe(false);
    }
  });
  it('network-level codes/messages are transient', () => {
    expect(isTransientError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });
  it('a user abort is NOT retried, but a server abort IS', () => {
    expect(isTransientError(new Error('The operation was aborted'))).toBe(false);
    expect(isTransientError(new Error('aborted by the server'))).toBe(true);
  });
});

describe('withRetry — control flow', () => {
  const fast = { baseMs: 1, capMs: 1 } as const;

  it('returns immediately on first success (calls fn once)', async () => {
    let calls = 0;
    const out = await withRetry(async () => { calls++; return 'ok'; }, fast);
    expect(out).toBe('ok');
    expect(calls).toBe(1);
  });

  it('does NOT retry a permanent error — throws after one call', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error('bad request'), { status: 400 });
    }, fast)).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });

  it('retries a transient error then succeeds', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('busy'), { status: 503 });
      return 'recovered';
    }, fast);
    expect(out).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('exhausts maxAttempts on persistent transient failure and throws the last error', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error('still down'), { status: 503 });
    }, { ...fast, maxAttempts: 3 })).rejects.toThrow('still down');
    expect(calls).toBe(3);
  });

  it('maxAttempts:1 means no retry even for transient errors', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      throw Object.assign(new Error('down'), { status: 503 });
    }, { ...fast, maxAttempts: 1 })).rejects.toThrow('down');
    expect(calls).toBe(1);
  });

  it('an already-aborted signal throws without ever calling fn', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await expect(withRetry(async () => { calls++; return 'x'; }, { ...fast, signal: ac.signal }))
      .rejects.toThrow(/abort/i);
    expect(calls).toBe(0);
  });
});
