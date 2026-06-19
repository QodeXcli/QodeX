import { describe, it, expect } from 'vitest';
import { detectStuckLoop, readLoopAction } from '../src/agent/recovery.js';
import { AgentLoop } from '../src/agent/loop.js';
import type { Message } from '../src/session/store.js';

const c = (name: string, argsHash: string) => ({ name, argsHash });

describe('detectStuckLoop', () => {
  it('returns false for fewer than 3 calls', () => {
    expect(detectStuckLoop([c('read_file', 'a'), c('read_file', 'b')])).toBe(false);
  });

  it('detects 3 identical calls in a row (period 1)', () => {
    expect(detectStuckLoop([c('read_file', 'x'), c('read_file', 'x'), c('read_file', 'x')])).toBe(true);
  });

  it('detects an A,B,C,A,B,C read cycle (period 3) — the real-world restart loop', () => {
    const cyc = ['a', 'b', 'c', 'a', 'b', 'c'].map(h => c('read_file', h));
    expect(detectStuckLoop(cyc)).toBe(true);
  });

  it('detects an A,B,A,B cycle (period 2)', () => {
    expect(detectStuckLoop([c('ls', 'a'), c('read_file', 'b'), c('ls', 'a'), c('read_file', 'b')])).toBe(true);
  });

  it('does NOT flag healthy varied progress', () => {
    expect(detectStuckLoop([
      c('read_file', 'a'), c('read_file', 'b'), c('grep', 'c'), c('write_file', 'd'), c('read_file', 'e'),
    ])).toBe(false);
  });

  it('does NOT flag a single A,B,C sweep with no repeat', () => {
    expect(detectStuckLoop([c('read_file', 'a'), c('read_file', 'b'), c('read_file', 'c')])).toBe(false);
  });
});

describe('readLoopAction — run-wide repeated-read escalation', () => {
  it('does nothing for the first couple of reads of a file', () => {
    expect(readLoopAction(0)).toBe('none');
    expect(readLoopAction(1)).toBe('none');
    expect(readLoopAction(2)).toBe('none');
  });

  it('forces a summary at the 3rd–4th identical read (restart detected)', () => {
    expect(readLoopAction(3)).toBe('summarize');
    expect(readLoopAction(4)).toBe('summarize');
  });

  it('aborts the run at the 5th identical read', () => {
    expect(readLoopAction(5)).toBe('abort');
    expect(readLoopAction(9)).toBe('abort');
  });
});

describe('pruneMessages — intra-group compaction for single-turn tasks', () => {
  const agent: any = new AgentLoop({
    router: {} as any, registry: {} as any, permissions: {} as any, config: {} as any, cwd: '/tmp',
  });

  function singleTurnHistory(): Message[] {
    // One user turn ("the task") + many assistant/tool turns — never splits into >2 groups,
    // so the OLD group-only pruner was a no-op and context grew unbounded.
    const msgs: Message[] = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'find the bugs' },
    ];
    for (let i = 0; i < 6; i++) {
      msgs.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: 't' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'f' + i }) } }],
      });
      msgs.push({ role: 'tool', tool_call_id: 't' + i, name: 'read_file', content: ('FILE_' + i + '_CONTENT ').repeat(60) });
    }
    return msgs;
  }

  function assertInvariants(out: Message[]): void {
    // No two consecutive user messages (strict providers reject this).
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.role === 'user' && out[i - 1]!.role === 'user').toBe(false);
    }
    // No orphaned tool result — each must follow an assistant or another tool.
    for (let i = 0; i < out.length; i++) {
      if (out[i]!.role === 'tool') {
        expect(i > 0 && (out[i - 1]!.role === 'assistant' || out[i - 1]!.role === 'tool')).toBe(true);
      }
    }
  }

  it('returns unchanged when under budget', () => {
    const msgs = singleTurnHistory();
    expect(agent.pruneMessages(msgs, 1_000_000)).toEqual(msgs);
  });

  it('compacts a single oversized turn-group (old code left this untouched)', () => {
    const msgs = singleTurnHistory();
    const out: Message[] = agent.pruneMessages(msgs, 200);
    expect(out.length).toBeLessThan(msgs.length);
    expect(out[0]!.role).toBe('system');
    // The anchor user message survives and carries the compaction notice + original task.
    expect(out[1]!.role).toBe('user');
    expect(out[1]!.content).toContain('[CONTEXT_COMPACTED]');
    expect(out[1]!.content).toContain('find the bugs');
    // The most recent unit is preserved (continuity, not a restart).
    const last = out[out.length - 1]!;
    expect(last.role === 'tool' || last.role === 'assistant').toBe(true);
    assertInvariants(out);
  });
});
