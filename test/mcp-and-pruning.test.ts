import { describe, it, expect } from 'vitest';
import { MCPClient } from '../src/mcp/client.js';
import { MCPToolWrapper } from '../src/mcp/tool-wrapper.js';

describe('MCPClient lifecycle', () => {
  it('reports stopped state when not started', () => {
    const c = new MCPClient('test', { command: '/bin/false' });
    expect(c.status.state).toBe('stopped');
    expect(c.tools).toEqual([]);
    expect(c.isReady()).toBe(false);
  });

  it('fails gracefully when spawning a non-existent command', async () => {
    const c = new MCPClient('bad', { command: '/this/does/not/exist/qodex-mcp-test', startupTimeoutSeconds: 2 });
    await expect(c.start()).rejects.toBeTruthy();
    expect(c.status.state).toBe('failed');
  });
});

describe('MCPToolWrapper', () => {
  it('builds a namespaced tool name', () => {
    const fakeClient = { name: 'fs', isReady: () => true, status: { state: 'ready' } } as any;
    const wrapper = new MCPToolWrapper(
      fakeClient,
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      true,
    );
    expect(wrapper.name).toBe('mcp:fs:read_file');
    expect(wrapper.description).toContain('[via MCP/fs]');
    expect(wrapper.isReadOnly).toBe(false);
    expect(wrapper.isDestructive).toBe(true);
  });

  it('uses the MCP-provided JSON Schema directly in tool schema (bypasses zod)', () => {
    const fakeClient = { name: 'svc', isReady: () => true } as any;
    const mcpSchema = {
      type: 'object' as const,
      properties: { x: { type: 'number' }, y: { type: 'string' } },
      required: ['x'],
    };
    const wrapper = new MCPToolWrapper(fakeClient, {
      name: 'doit',
      inputSchema: mcpSchema,
    });
    const s = wrapper.schema();
    expect(s.function.parameters).toBe(mcpSchema);
  });

  it('marks tools from non-destructive servers as read-only', () => {
    const fakeClient = { name: 'docs' } as any;
    const wrapper = new MCPToolWrapper(
      fakeClient,
      { name: 'search', inputSchema: { type: 'object', properties: {} } },
      false, // non-destructive
    );
    expect(wrapper.isReadOnly).toBe(true);
    expect(wrapper.isDestructive).toBe(false);
  });
});

describe('Pruning produces a single user message at the boundary', () => {
  // The compaction notice must be MERGED into the first kept user message,
  // not inserted as a separate user message (which would produce two
  // consecutive user messages and break Anthropic / strict Ollama models).

  // Inline copy of the logic (the real method is private to AgentLoop)
  function pruneAtBoundary(
    messages: Array<{ role: string; content: string | null }>,
    droppedGroupsCount: number,
  ): Array<{ role: string; content: string | null }> {
    const notice = `[CONTEXT_COMPACTED] ${droppedGroupsCount} earlier turn(s) omitted.\n\n---\n\n`;
    const flat = messages.slice();
    const first = flat[0];
    if (first?.role === 'user' && typeof first.content === 'string') {
      flat[0] = { ...first, content: notice + first.content };
      return flat;
    }
    return [{ role: 'user', content: notice }, ...flat];
  }

  it('merges notice into the first user message without creating duplicates', () => {
    const input = [
      { role: 'user', content: 'do task X' },
      { role: 'assistant', content: 'sure' },
    ];
    const out = pruneAtBoundary(input, 3);
    // Should be 2 messages still, not 3
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.content).toContain('CONTEXT_COMPACTED');
    expect(out[0]!.content).toContain('do task X');
    expect(out[1]!.role).toBe('assistant');
  });

  it('never produces two consecutive user messages', () => {
    const input = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'more' },
    ];
    const out = pruneAtBoundary(input, 5);
    for (let i = 1; i < out.length; i++) {
      if (out[i - 1]!.role === 'user') {
        expect(out[i]!.role).not.toBe('user');
      }
    }
  });
});
