import { describe, it, expect } from 'vitest';
import { compactMessages } from '../src/utils/compaction.js';
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

describe('compaction refuses to trade real history for an empty summary', () => {
  // The user's instruction is stated ONCE at the start — exactly what compaction exists to
  // carry forward, and exactly what a failed summarization used to destroy.
  const build = () => {
    const m: any[] = [{ role: 'system', content: 'sys' }];
    m.push({ role: 'user', content: 'Refactor auth. IMPORTANT: do NOT run npm install, frontend at web/src/.' });
    m.push({ role: 'assistant', content: 'ok' });
    for (let i = 0; i < 20; i++) {
      m.push({ role: 'user', content: `step ${i}` });
      m.push({ role: 'assistant', content: `did ${i}` });
    }
    return m;
  };
  const survives = (msgs: any[]) => {
    const all = JSON.stringify(msgs);
    return all.includes('do NOT run npm install') && all.includes('web/src/');
  };

  it('still compacts on a usable summary', async () => {
    const r = await compactMessages(build(), {
      keepLastTurns: 6,
      summarize: async () => '[CTX_SUMMARY]\nGoal: refactor auth. Constraint: do NOT run npm install. Frontend at web/src/. Files: auth.ts.',
    });
    expect(r.turnsCompacted).toBeGreaterThan(0);
    expect(survives(r.messages)).toBe(true);
  });

  for (const [label, summary] of [
    ['an empty string (aborted stream)', ''],
    ['whitespace only', '   \n  '],
    ['the prefix with no body', '[CTX_SUMMARY]'],
    ['a summary too short to carry goal + path + constraint', '[CTX_SUMMARY]\nrefactored stuff'],
  ] as [string, string][]) {
    it(`keeps the original messages when the summarizer returns ${label}`, async () => {
      const original = build();
      const r = await compactMessages(original, { keepLastTurns: 6, summarize: async () => summary });
      // Skipping one compaction is cheap; losing the user's standing instruction is not.
      expect(r.turnsCompacted).toBe(0);
      expect(r.messages).toEqual(original);
      expect(survives(r.messages)).toBe(true);
    });
  }

  it('keeps the original messages when the summarizer throws', async () => {
    const original = build();
    const r = await compactMessages(original, {
      keepLastTurns: 6,
      summarize: async () => { throw new Error('stream died'); },
    });
    expect(r.turnsCompacted).toBe(0);
    expect(survives(r.messages)).toBe(true);
  });
});
