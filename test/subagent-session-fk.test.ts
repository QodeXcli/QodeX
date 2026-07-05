/**
 * Regression test: dispatching a sub-agent must not die with
 * "FOREIGN KEY constraint failed" on its first session-store write.
 *
 * The bug: dispatchers (task/fanout/gather) fabricate a child session id
 * (`<parent>/sub-<ts>`) that was never INSERTed into `sessions`, while
 * messages.session_id carries a FK to sessions.id (and foreign_keys=ON).
 * The sub-agent's first recordTurn therefore threw, so delegation NEVER worked.
 *
 * Fix: AgentLoop.runSubagent calls SessionStore.ensureSession(id, cwd, model)
 * before running the child loop.
 */
import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { SessionStore, getSessionStore, type Message } from '../src/session/store.js';
import { AgentLoop } from '../src/agent/loop.js';

// Redirect the store singleton to a temp DB so AgentLoop.runSubagent (which uses
// getSessionStore()) never touches the user's real ~/.qodex/sessions.db.
vi.mock('../src/session/store.js', async (importOriginal) => {
  const mod: any = await importOriginal();
  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-subagent-fk-'));
  let store: any = null;
  return {
    ...mod,
    getSessionStore: () => (store ??= new mod.SessionStore(path.join(dir, 'sessions.db'))),
  };
});

function freshStore(name: string): SessionStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qodex-${name}-`));
  return new SessionStore(path.join(dir, 'sessions.db'));
}

const assistantMsg: Message = { role: 'assistant', content: 'sub-agent says hi' };

describe('SessionStore.ensureSession — sub-agent session FK', () => {
  it('documents the bug shape: first write under an unknown session id violates the FK', () => {
    const store = freshStore('fk-shape');
    expect(() =>
      store.recordTurn('parent-abc/sub-1751700000000', [assistantMsg], { input: 1, output: 1, costUsd: 0 }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('ensureSession creates the parent row so the child\'s first write succeeds', () => {
    const store = freshStore('fk-fixed');
    const subId = 'parent-abc/sub-1751700000000';
    store.ensureSession(subId, '/tmp/project', 'ollama/glm-5.2');
    expect(() =>
      store.recordTurn(subId, [assistantMsg], { input: 1, output: 1, costUsd: 0 }),
    ).not.toThrow();
    const loaded = store.loadSession(subId);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.meta.model).toBe('ollama/glm-5.2');
  });

  it('is idempotent and never clobbers an existing session row', () => {
    const store = freshStore('fk-idempotent');
    const id = store.createSession('/tmp/project', 'model-a');
    store.recordTurn(id, [{ role: 'user', content: 'hi' }], { input: 5, output: 0, costUsd: 0 });
    store.ensureSession(id, '/somewhere/else', 'model-b'); // must be a no-op
    const loaded = store.loadSession(id)!;
    expect(loaded.meta.model).toBe('model-a');
    expect(loaded.meta.cwd).toBe('/tmp/project');
    expect(loaded.messages).toHaveLength(1);
  });
});

describe('AgentLoop.runSubagent — creates the child session row before the first write', () => {
  it('the child loop\'s first recordTurn succeeds (no FK error)', async () => {
    const agent: any = new AgentLoop({
      router: { resolveModel: () => null } as any,
      registry: { list: () => [] } as any,
      permissions: {} as any,
      config: { defaults: { provider: 'ollama', model: 'glm-5.2' } } as any,
      cwd: '/tmp/project',
    });

    // Mock the LLM side entirely: the child run persists ONE assistant message
    // (exactly what the real loop does on its first turn) then finishes.
    agent.buildInitialMessages = async (prompt: string): Promise<Message[]> => [
      { role: 'system', content: 'sub-agent system prompt' },
      { role: 'user', content: prompt },
    ];
    agent.run = async function* (_messages: Message[], sessionId: string) {
      getSessionStore().recordTurn(sessionId, [assistantMsg], { input: 3, output: 2, costUsd: 0 });
      yield { type: 'final', data: { content: 'done' } };
    };

    const subSessionId = 'parent-session/sub-1751700000001';
    const result = await agent.runSubagent('do a focused thing', {
      maxIterations: 3,
      sessionId: subSessionId,
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe('done');

    // The child session row was created up front and its first message landed.
    const loaded = getSessionStore().loadSession(subSessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.meta.cwd).toBe('/tmp/project');
    expect(loaded!.meta.model).toBe('ollama/glm-5.2');
    expect(loaded!.messages).toHaveLength(1);
  });
});
