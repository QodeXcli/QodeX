import { describe, it, expect } from 'vitest';
import { StreamPump, type PumpIO } from '../src/bot/stream-pump.ts';
import type { MessageRef } from '../src/bot/types.ts';

/** A fake transport that records every send/edit, with a hand-driven clock. */
function fakeIO(maxLen = 50, minIntervalMs = 1000) {
  const log: Array<{ op: 'send' | 'edit'; id: string; text: string }> = [];
  let clock = 0;
  let n = 0;
  const messages = new Map<string, string>();
  const io: PumpIO = {
    maxLen,
    minIntervalMs,
    now: () => clock,
    send: async (text) => { const id = `m${++n}`; messages.set(id, text); log.push({ op: 'send', id, text }); return { id } as MessageRef; },
    edit: async (ref, text) => { messages.set(ref.id, text); log.push({ op: 'edit', id: ref.id, text }); },
  };
  return { io, log, messages, tick: (ms: number) => { clock += ms; }, sends: () => log.filter(l => l.op === 'send').length, edits: () => log.filter(l => l.op === 'edit').length };
}

describe('StreamPump', () => {
  it('throttles: many rapid pushes inside one window cause at most the first send', async () => {
    const f = fakeIO(100, 1000);
    const pump = new StreamPump(f.io);
    await pump.push('a');          // t=0 → first flush sends
    await pump.push('b');          // still t=0 → deferred
    await pump.push('c');          // deferred
    expect(f.sends()).toBe(1);
    expect(f.edits()).toBe(0);     // no edit storm
    await pump.finish();
    expect(f.messages.get('m1')).toBe('abc'); // final state correct
  });

  it('edits once per elapsed interval as text grows', async () => {
    const f = fakeIO(100, 1000);
    const pump = new StreamPump(f.io);
    await pump.push('hello');      // t=0 send
    f.tick(1000); await pump.push(' world'); // edit
    f.tick(1000); await pump.push('!');      // edit
    expect(f.sends()).toBe(1);
    expect(f.edits()).toBe(2);
    await pump.finish();
    expect(f.messages.get('m1')).toBe('hello world!');
  });

  it('never edits with identical content (no no-op edits)', async () => {
    const f = fakeIO(100, 0);
    const pump = new StreamPump(f.io);
    await pump.push('same');
    await pump.push('');          // no new text
    await pump.finish();
    expect(f.edits()).toBe(0);
  });

  it('spills into a NEW message when text outgrows maxLen, never re-sending finalized text', async () => {
    const f = fakeIO(20, 0);      // tiny cap, no throttle
    const pump = new StreamPump(f.io);
    const big = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'); // > 20 chars
    await pump.push(big);
    await pump.finish();
    // reassemble what the user sees across all live messages
    const finalMessages = [...f.messages.values()];
    expect(finalMessages.length).toBeGreaterThan(1);
    // the joined visible text must contain every original line exactly
    const joined = finalMessages.join('\n');
    for (let i = 0; i < 10; i++) expect(joined).toContain(`line${i}`);
  });

  it('finish() always emits even if the throttle was holding text', async () => {
    const f = fakeIO(100, 10_000); // huge interval
    const pump = new StreamPump(f.io);
    await pump.push('buffered');   // t=0 send
    await pump.push(' more');      // deferred (interval not elapsed)
    expect(f.messages.get('m1')).toBe('buffered');
    await pump.finish();           // forces it out
    expect(f.messages.get('m1')).toBe('buffered more');
  });
});
