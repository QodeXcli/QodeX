import { describe, it, expect } from 'vitest';
import { compactFileReads, extractOutline } from '../src/agent/read-cache.js';
import type { Message } from '../src/session/store.js';

function readCall(id: string, path: string, extra: Record<string, unknown> = {}): Message {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path, ...extra }) } }],
  };
}
function readResult(id: string, content: string): Message {
  return { role: 'tool', tool_call_id: id, name: 'read_file', content };
}

const MARK = '[QodeX context-cache]';
const isStub = (m: Message) => typeof m.content === 'string' && m.content.startsWith(MARK);

describe('read-cache: lossless superseded collapse', () => {
  it('stubs an earlier full read superseded by a later full read; keeps the latest', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'go' },
      readCall('a', '/Hero.jsx'),
      readResult('a', 'FULL BODY v1'),
      readCall('b', '/Hero.jsx'),
      readResult('b', 'FULL BODY v2 (current)'),
    ];
    const out = compactFileReads(msgs);
    expect(isStub(out[2])).toBe(true); // earlier full → stubbed
    expect(out[4].content).toBe('FULL BODY v2 (current)'); // latest kept
    expect(out.length).toBe(msgs.length); // length preserved
  });

  it('stubs a section read superseded by a later FULL read of the same path', () => {
    const msgs: Message[] = [
      readCall('a', '/Hero.jsx', { offset: 100, limit: 50 }),
      readResult('a', 'SECTION 100-150'),
      readCall('b', '/Hero.jsx'),
      readResult('b', 'FULL BODY'),
    ];
    const out = compactFileReads(msgs);
    expect(isStub(out[1])).toBe(true);
    expect(out[3].content).toBe('FULL BODY');
  });

  it('does NOT stub a single read (lossless mode keeps non-superseded reads)', () => {
    const msgs: Message[] = [readCall('a', '/Once.jsx'), readResult('a', 'BODY')];
    const out = compactFileReads(msgs);
    expect(isStub(out[1])).toBe(false);
  });

  it('does NOT treat a later SECTION read as superseding an earlier FULL read', () => {
    const msgs: Message[] = [
      readCall('a', '/Hero.jsx'),
      readResult('a', 'FULL BODY'),
      readCall('b', '/Hero.jsx', { offset: 10, limit: 5 }),
      readResult('b', 'SECTION'),
    ];
    const out = compactFileReads(msgs);
    expect(out[1].content).toBe('FULL BODY'); // full read NOT clobbered by a later partial
  });

  it('preserves tool_call_id pairing when stubbing', () => {
    const msgs: Message[] = [
      readCall('a', '/Hero.jsx'),  // idx 0: assistant tool_call
      readResult('a', 'v1'),       // idx 1: tool result → superseded → stubbed
      readCall('b', '/Hero.jsx'),  // idx 2: assistant tool_call (no tool_call_id)
      readResult('b', 'v2'),       // idx 3: tool result (latest, kept)
    ];
    const out = compactFileReads(msgs);
    expect(isStub(out[1])).toBe(true);        // the stubbed result
    expect(out[1].tool_call_id).toBe('a');    // pairing preserved
    expect(out[1].role).toBe('tool');
  });
});

describe('read-cache: opt-in outline aging', () => {
  it('ages an OLD non-superseded read into an outline stub, keeps recent reads full', () => {
    // 10 messages; recentWindow=4 → boundary at index 6. Read at idx 1 is old.
    const msgs: Message[] = [
      readCall('a', '/Old.jsx'),
      readResult('a', 'line1\nline2\nOUTLINE (symbol → lines):\n  foo → 1-10\n  bar → 11-20\nHEAD\n...'),
    ];
    for (let i = 0; i < 4; i++) msgs.push({ role: 'assistant', content: `step ${i}` });
    msgs.push(readCall('z', '/Recent.jsx'));
    msgs.push(readResult('z', 'RECENT BODY'));
    const out = compactFileReads(msgs, { agingOutline: true, recentWindow: 4 });
    expect(isStub(out[1])).toBe(true);               // old read aged
    expect(out[1].content).toContain('foo → 1-10');  // outline preserved
    expect(out[out.length - 1].content).toBe('RECENT BODY'); // recent kept full
  });

  it('with aging OFF, old single reads are left untouched', () => {
    const msgs: Message[] = [readCall('a', '/Old.jsx'), readResult('a', 'BODY')];
    for (let i = 0; i < 30; i++) msgs.push({ role: 'assistant', content: `s${i}` });
    const out = compactFileReads(msgs, { agingOutline: false });
    expect(isStub(out[1])).toBe(false);
  });
});

describe('read-cache: extractOutline', () => {
  it('pulls the OUTLINE block out of a read_file result', () => {
    const c = 'head\nOUTLINE (symbol → lines):\n  A → 1-5\n  B → 6-9\nHEAD\nactual code...';
    const o = extractOutline(c);
    expect(o).toContain('A → 1-5');
    expect(o).not.toContain('actual code');
  });
  it('returns null when there is no outline', () => {
    expect(extractOutline('just a short file body')).toBeNull();
  });
});
