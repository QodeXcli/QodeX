import { describe, it, expect } from 'vitest';
import {
  serializeMessage,
  commonPrefixLength,
  prefixChars,
  describeCacheReuse,
  computeThroughput,
} from '../src/llm/cache-layout.js';
import type { Message } from '../src/session/store.js';

const sys: Message = { role: 'system', content: 'You are QodeX.' };
const u1: Message = { role: 'user', content: 'add a button' };
const a1: Message = {
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x.ts"}' } }],
};
const t1: Message = { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'file body' };
const u2: Message = { role: 'user', content: 'now verify' };

describe('serializeMessage', () => {
  it('is stable for identical messages', () => {
    expect(serializeMessage(u1)).toBe(serializeMessage({ role: 'user', content: 'add a button' }));
  });
  it('differs when tool_calls differ', () => {
    const a2: Message = { ...a1, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"y.ts"}' } }] };
    expect(serializeMessage(a1)).not.toBe(serializeMessage(a2));
  });
});

describe('commonPrefixLength', () => {
  it('counts identical leading messages', () => {
    const prev = [sys, u1, a1, t1];
    const next = [sys, u1, a1, t1, u2];
    expect(commonPrefixLength(prev, next)).toBe(4);
  });
  it('stops at the first divergence', () => {
    const prev = [sys, u1, a1];
    const next = [sys, { role: 'user', content: 'different' } as Message, a1];
    expect(commonPrefixLength(prev, next)).toBe(1);
  });
  it('is 0 when the system block changes (prefix-busting)', () => {
    const prev = [sys, u1];
    const next = [{ role: 'system', content: 'You are QodeX. (rebuilt)' } as Message, u1];
    expect(commonPrefixLength(prev, next)).toBe(0);
  });
});

describe('prefixChars', () => {
  it('sums serialized length of the first n messages', () => {
    const msgs = [sys, u1];
    expect(prefixChars(msgs, 2)).toBe(serializeMessage(sys).length + serializeMessage(u1).length);
  });
  it('clamps n to array length', () => {
    expect(prefixChars([sys], 5)).toBe(serializeMessage(sys).length);
  });
});

describe('describeCacheReuse', () => {
  it('reports zero reuse on the first turn', () => {
    const r = describeCacheReuse(null, [sys, u1]);
    expect(r.reusedMessages).toBe(0);
    expect(r.reuseRatio).toBe(0);
  });
  it('reports a healthy append-only turn as near-full reuse', () => {
    const prev = [sys, u1, a1, t1];
    const next = [sys, u1, a1, t1, u2];
    const r = describeCacheReuse(prev, next);
    expect(r.reusedMessages).toBe(4);
    expect(r.totalMessages).toBe(5);
    expect(r.changedAt).toBe(4);
    expect(r.reuseRatio).toBeCloseTo(4 / 5);
    expect(r.reusedChars).toBeGreaterThan(0);
  });
  it('flags a prefix-busting change as changedAt 0', () => {
    const prev = [sys, u1];
    const next = [{ role: 'system', content: 'mutated' } as Message, u1];
    const r = describeCacheReuse(prev, next);
    expect(r.reusedMessages).toBe(0);
    expect(r.changedAt).toBe(0);
  });
});

describe('computeThroughput', () => {
  it('computes tokens per second', () => {
    expect(computeThroughput(100, 1000)).toBe(100);
    expect(computeThroughput(50, 2000)).toBe(25);
  });
  it('guards against zero/negative latency', () => {
    expect(computeThroughput(100, 0)).toBe(0);
    expect(computeThroughput(100, -5)).toBe(0);
    expect(computeThroughput(0, 1000)).toBe(0);
  });
});
