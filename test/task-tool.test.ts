import { describe, it, expect, beforeEach } from 'vitest';
import { TaskTool, setSubAgentRunner } from '../src/tools/builtin/task.js';
import type { ToolContext } from '../src/tools/base.js';

function makeCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: 'parent-session',
    transaction: {} as any,
    permissions: { evaluate: () => 'allow' } as any,
    askUser: async () => 'allow',
    emit: () => {},
    signal: new AbortController().signal,
  } as ToolContext;
}

describe('TaskTool', () => {
  beforeEach(() => {
    setSubAgentRunner(null);
  });

  it('returns SUBAGENT_DISABLED when no runner is wired', async () => {
    const tool = new TaskTool();
    const r = await tool.execute(
      { description: 'test', prompt: 'do a thing' },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('SUBAGENT_DISABLED');
    expect(r.content).toContain('qx setup');
  });

  it('dispatches to the runner and returns its summary on success', async () => {
    let receivedPrompt: string | null = null;
    let receivedOpts: any = null;
    setSubAgentRunner(async (prompt, opts) => {
      receivedPrompt = prompt;
      receivedOpts = opts;
      return { finalText: 'Refactored 5 files.', toolCallsRun: 12, ok: true };
    });

    const tool = new TaskTool();
    const r = await tool.execute(
      {
        description: 'refactor all test files',
        prompt: 'Update all test files to use new mock helpers.',
        max_iterations: 15,
      },
      makeCtx(),
    );

    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('SUBAGENT_DONE');
    expect(r.content).toContain('refactor all test files');
    expect(r.content).toContain('Refactored 5 files');
    expect(r.content).toContain('12 tool call');
    expect(receivedPrompt).toContain('Update all test files');
    expect(receivedOpts.maxIterations).toBe(15);
  });

  it('surfaces sub-agent failure with partial output', async () => {
    setSubAgentRunner(async () => ({
      finalText: 'Got 2 files in before crashing.',
      toolCallsRun: 3,
      ok: false,
      error: 'Budget exceeded',
    }));

    const tool = new TaskTool();
    const r = await tool.execute(
      { description: 'huge task', prompt: 'do everything' },
      makeCtx(),
    );

    expect(r.isError).toBe(true);
    expect(r.content).toContain('SUBAGENT_FAILED');
    expect(r.content).toContain('Budget exceeded');
    expect(r.content).toContain('Got 2 files in');
    expect(r.content).toContain('3 tool call');
  });

  it('passes max_iterations default when omitted', async () => {
    let captured: any = null;
    setSubAgentRunner(async (_p, opts) => {
      captured = opts;
      return { finalText: '', toolCallsRun: 0, ok: true };
    });
    const tool = new TaskTool();
    await tool.execute({ description: 'x', prompt: 'y' }, makeCtx());
    expect(captured.maxIterations).toBe(8); // default
  });

  it('generates a unique sub-session id per call', async () => {
    const seen = new Set<string>();
    setSubAgentRunner(async (_p, opts) => {
      seen.add(opts.sessionId);
      return { finalText: '', toolCallsRun: 0, ok: true };
    });
    const tool = new TaskTool();
    await tool.execute({ description: 'a', prompt: 'a' }, makeCtx());
    // Sleep a moment so timestamps differ
    await new Promise(r => setTimeout(r, 10));
    await tool.execute({ description: 'b', prompt: 'b' }, makeCtx());
    expect(seen.size).toBe(2);
    for (const sid of seen) {
      expect(sid).toContain('parent-session/sub-');
    }
  });
});
