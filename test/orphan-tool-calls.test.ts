import { describe, it, expect } from 'vitest';
import { answerOrphanToolCalls } from '../src/llm/providers/openai.js';
import type { Message } from '../src/session/store.js';

// Regression: a loop detector (read-loop / stuck-loop / error-loop) used to push a system
// message and `continue` WITHOUT executing the just-emitted tool_calls, leaving them
// unanswered. OpenAI-format providers (kimi, DeepSeek, LM Studio) then 400 with
// "an assistant message with 'tool_calls' must be followed by tool messages responding
// to each 'tool_call_id'". This is the provider-side safety net that repairs any such orphan.

const asst = (calls: { id: string; name: string }[]): Message => ({
  role: 'assistant', content: '',
  tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: '{}' } })),
} as any);
const toolMsg = (id: string, name: string): Message => ({ role: 'tool', tool_call_id: id, name, content: 'ok' } as any);
const user = (t: string): Message => ({ role: 'user', content: t });

// Every assistant tool_call id must have a following tool message with that id, before any non-tool message.
function orphanIds(msgs: Message[]): string[] {
  const orphans: string[] = [];
  let pending: string[] = [];
  for (const m of msgs) {
    if (m.role === 'tool') { pending = pending.filter(id => id !== (m as any).tool_call_id); continue; }
    orphans.push(...pending); pending = [];
    if (m.role === 'assistant' && (m as any).tool_calls) pending = (m as any).tool_calls.map((tc: any) => tc.id);
  }
  orphans.push(...pending);
  return orphans;
}

describe('answerOrphanToolCalls', () => {
  it('repairs the exact loop-detector bug: assistant(tool_calls) → user system msg, no results', () => {
    const buggy: Message[] = [
      user('check the repo'),
      asst([{ id: 'read_file:44', name: 'read_file' }, { id: 'grep:45', name: 'grep' }]),
      user('[SYSTEM] You have re-read the same file 3 times — STOP calling tools.'),
    ];
    expect(orphanIds(buggy)).toEqual(['read_file:44', 'grep:45']); // proves the bug exists pre-repair
    const fixed = answerOrphanToolCalls(buggy);
    expect(orphanIds(fixed)).toEqual([]); // every id now answered
    // the synthetic results carry the right ids and land BEFORE the system message
    const readIdx = fixed.findIndex(m => (m as any).tool_call_id === 'read_file:44');
    const sysIdx = fixed.findIndex(m => m.role === 'user' && String(m.content).includes('[SYSTEM]'));
    expect(readIdx).toBeGreaterThan(0);
    expect(readIdx).toBeLessThan(sysIdx);
  });

  it('leaves a well-formed conversation untouched (idempotent)', () => {
    const ok: Message[] = [
      asst([{ id: 'a:1', name: 'read_file' }]),
      toolMsg('a:1', 'read_file'),
      user('thanks'),
    ];
    expect(answerOrphanToolCalls(ok)).toEqual(ok);
    expect(answerOrphanToolCalls(answerOrphanToolCalls(ok))).toEqual(answerOrphanToolCalls(ok));
  });

  it('repairs a partially-answered batch (one of two results missing)', () => {
    const partial: Message[] = [
      asst([{ id: 'x:1', name: 'read_file' }, { id: 'y:2', name: 'ls' }]),
      toolMsg('x:1', 'read_file'), // y:2 never answered
      user('next'),
    ];
    const fixed = answerOrphanToolCalls(partial);
    expect(orphanIds(fixed)).toEqual([]);
    expect(fixed.filter(m => (m as any).tool_call_id === 'y:2')).toHaveLength(1);
  });

  it('handles an orphan at end-of-history (no trailing message)', () => {
    const trailing: Message[] = [asst([{ id: 'z:9', name: 'grep' }])];
    const fixed = answerOrphanToolCalls(trailing);
    expect(orphanIds(fixed)).toEqual([]);
    expect(fixed[fixed.length - 1]).toMatchObject({ role: 'tool', tool_call_id: 'z:9' });
  });

  it('does not confuse ids across two assistant turns', () => {
    const two: Message[] = [
      asst([{ id: 't1:1', name: 'read_file' }]), toolMsg('t1:1', 'read_file'), user('ok'),
      asst([{ id: 't2:1', name: 'read_file' }]), // orphaned
      user('[SYSTEM] loop'),
    ];
    const fixed = answerOrphanToolCalls(two);
    expect(orphanIds(fixed)).toEqual([]);
    expect(fixed.filter(m => m.role === 'tool')).toHaveLength(2);
  });
});
