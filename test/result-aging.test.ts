import { describe, it, expect } from 'vitest';
import { ageToolResults } from '../src/agent/result-aging.js';
import type { Message } from '../src/session/store.js';

const bigLog = 'line\n'.repeat(12_000) + 'ERROR: build failed at src/App.tsx:42';

const mkHistory = (): Message[] => ([
  { role: 'user', content: 'fix the build' },
  { role: 'assistant', content: 'running build' },
  { role: 'tool', tool_call_id: '1', name: 'shell', content: bigLog } as any,
  { role: 'assistant', content: 'reading file' },
  { role: 'tool', tool_call_id: '2', name: 'read_file', content: 'x'.repeat(20_000) } as any,
  { role: 'assistant', content: 'editing' },
  { role: 'tool', tool_call_id: '3', name: 'shell', content: 'y'.repeat(9_000) } as any,
  { role: 'assistant', content: 'done?' },
]);

describe('ageToolResults', () => {
  it('ages a large old shell log to a head+tail stub, preserving the trailing error', () => {
    const r = ageToolResults(mkHistory());
    expect(r.aged).toBe(1);
    const c = r.messages[2]!.content as string;
    expect(c.startsWith('[QodeX aged-result]')).toBe(true);
    expect(c).toContain('ERROR: build failed at src/App.tsx:42');
    expect(r.bytesSaved).toBeGreaterThan(50_000);
  });

  it('leaves read_file results alone (owned by read-cache)', () => {
    const r = ageToolResults(mkHistory());
    expect(r.messages[4]!.content).toBe('x'.repeat(20_000));
  });

  it('leaves recent results alone (younger than minAgeTurns)', () => {
    const r = ageToolResults(mkHistory());
    expect(r.messages[6]!.content).toBe('y'.repeat(9_000));
  });

  it('preserves message count and order', () => {
    const h = mkHistory();
    const r = ageToolResults(h);
    expect(r.messages).toHaveLength(h.length);
    expect(r.messages.map(m => m.role)).toEqual(h.map(m => m.role));
  });

  it('is idempotent (a second pass ages nothing)', () => {
    const r1 = ageToolResults(mkHistory());
    const r2 = ageToolResults(r1.messages);
    expect(r2.aged).toBe(0);
  });

  it('never touches small outputs', () => {
    const msgs: Message[] = [
      { role: 'tool', tool_call_id: '1', name: 'shell', content: 'ok' } as any,
      { role: 'assistant', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    expect(ageToolResults(msgs).aged).toBe(0);
  });

  it('respects custom thresholds', () => {
    // With minAgeTurns 1, the 9k-char recent-ish result becomes eligible
    const r = ageToolResults(mkHistory(), { minAgeTurns: 1, maxChars: 8_000 });
    expect(r.aged).toBe(2);
  });
});
