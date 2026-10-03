/**
 * MCP tools ask ONE question per call: Sentinel's (when it classifies the name) or the
 * wrapper's "Run MCP tool …?" — never both. In auto mode Sentinel's verdict is the policy
 * and the wrapper never asks; "always yes" in the wrapper switches to auto and never
 * bypasses a critical (send / pay / credential) name.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Sentinel, getSentinel, setSentinelForTests, isSentinelPrompt } from '../src/sentinel/guard.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';
import { ApprovalBroker } from '../src/control/approvals.js';
import { PermissionEngine, getApprovalMode, setApprovalMode } from '../src/security/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { MCPToolWrapper } from '../src/mcp/tool-wrapper.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/base.js';

let tmp: string;
let broker: ApprovalBroker;
let calls: string[];

function client(name: string) {
  return {
    name,
    isReady: () => true,
    status: { state: 'ready' },
    callTool: async (tool: string) => { calls.push(`${name}:${tool}`); return { content: [{ type: 'text', text: 'ok' }] }; },
  } as any;
}

function registryWith(...tools: Array<[server: string, tool: string]>) {
  const reg = new ToolRegistry();
  for (const [server, tool] of tools) {
    reg.register(new MCPToolWrapper(client(server), { name: tool, inputSchema: { type: 'object', properties: {} } }, true));
  }
  return reg;
}

function makeCtx(answers: string[] | string, permissions = new PermissionEngine(DEFAULT_CONFIG)) {
  const asked: Array<{ prompt: string; options?: string[] }> = [];
  const queue = Array.isArray(answers) ? [...answers] : null;
  const ctx: ToolContext = {
    cwd: tmp,
    sessionId: 'mcp-auto',
    transaction: {} as any,
    permissions,
    askUser: async (prompt, options) => {
      asked.push({ prompt, options });
      return queue ? (queue.shift() ?? 'no') : (answers as string);
    },
    emit: () => {},
  };
  return { ctx, asked };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-automode-mcp-'));
  broker = new ApprovalBroker();
  calls = [];
  setApprovalMode('manual');
  setSentinelForTests(new Sentinel({
    config: () => ({ ...DEFAULT_SENTINEL_CONFIG, audit: false }),
    audit: null,
    broker: () => broker,
    interactive: () => true,
    browser: () => null,
  }));
});
afterEach(async () => {
  setApprovalMode('manual');
  setSentinelForTests(null);
  broker.reset();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('MCP: one prompt per call', () => {
  it('manual: a delete-named tool is asked once (Sentinel), not again by the wrapper', async () => {
    const reg = registryWith(['gdrive', 'delete_file']);
    const { ctx, asked } = makeCtx('yes');
    const r = await reg.execute('mcp:gdrive:delete_file', {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(isSentinelPrompt(asked[0].prompt)).toBe(true);
    expect(calls).toEqual(['gdrive:delete_file']);
  });

  it("manual: the agent loop's preflight approval also answers the wrapper (one prompt)", async () => {
    const reg = registryWith(['gdrive', 'delete_file']);
    const { ctx, asked } = makeCtx('yes');
    expect(await getSentinel().preflight('mcp:gdrive:delete_file', {}, ctx)).toBeNull();
    const r = await reg.execute('mcp:gdrive:delete_file', {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(calls).toEqual(['gdrive:delete_file']);
  });

  it('manual: a critical send tool is asked once (the human yes/no), not again by the wrapper', async () => {
    const reg = registryWith(['slack', 'post_message']);
    const { ctx, asked } = makeCtx('yes');
    const r = await reg.execute('mcp:slack:post_message', {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(asked[0].options).toEqual(['yes', 'no']);
    expect(calls).toEqual(['slack:post_message']);
  });

  it('manual: an unclassified tool gets only the wrapper prompt', async () => {
    const reg = registryWith(['notes', 'write_note']);
    const { ctx, asked } = makeCtx('yes');
    await reg.execute('mcp:notes:write_note', {}, ctx);
    expect(asked).toHaveLength(1);
    expect(asked[0].prompt).toMatch(/^Run MCP tool mcp:notes:write_note/);
    expect(calls).toEqual(['notes:write_note']);
  });

  it('manual: declining Sentinel stops the call before the wrapper', async () => {
    const reg = registryWith(['gdrive', 'delete_file']);
    const { ctx, asked } = makeCtx('no');
    const r = await reg.execute('mcp:gdrive:delete_file', {}, ctx);
    expect(r.content).toMatch(/^\[SENTINEL_DENIED\]/);
    expect(asked).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("an approval of one call doesn't carry over to the next call of the same tool", async () => {
    const reg = registryWith(['gdrive', 'delete_file']);
    const { ctx, asked } = makeCtx(['yes', 'no']);
    await reg.execute('mcp:gdrive:delete_file', {}, ctx);
    const second = await reg.execute('mcp:gdrive:delete_file', {}, ctx);
    expect(second.content).toMatch(/^\[SENTINEL_DENIED\]/);
    expect(asked).toHaveLength(2);
    expect(calls).toEqual(['gdrive:delete_file']);
  });
});

describe('MCP in auto mode follows Sentinel', () => {
  it('read verbs and unclassified tools run without any prompt', async () => {
    setApprovalMode('auto');
    const reg = registryWith(['gdrive', 'list_files'], ['notes', 'write_note']);
    const { ctx, asked } = makeCtx('no');
    expect((await reg.execute('mcp:gdrive:list_files', {}, ctx)).isError).toBeFalsy();
    expect((await reg.execute('mcp:notes:write_note', {}, ctx)).isError).toBeFalsy();
    expect(asked).toHaveLength(0);
    expect(calls).toEqual(['gdrive:list_files', 'notes:write_note']);
  });

  it('delete / publish through a remote server ask once (Sentinel, with the auto-mode reason)', async () => {
    setApprovalMode('auto');
    const reg = registryWith(['gdrive', 'delete_file'], ['vercel', 'deploy_project']);
    const { ctx, asked } = makeCtx('yes');
    await reg.execute('mcp:gdrive:delete_file', {}, ctx);
    await reg.execute('mcp:vercel:deploy_project', {}, ctx);
    expect(asked).toHaveLength(2);
    for (const a of asked) expect(a.prompt).toContain('Auto mode still asks');
    expect(calls).toEqual(['gdrive:delete_file', 'vercel:deploy_project']);
  });

  it('critical names still need the human; "no" means it never runs', async () => {
    setApprovalMode('auto');
    const reg = registryWith(['slack', 'post_message'], ['stripe', 'create_charge']);
    const { ctx, asked } = makeCtx('no');
    expect((await reg.execute('mcp:slack:post_message', {}, ctx)).content).toMatch(/^\[SENTINEL_DENIED\]/);
    expect((await reg.execute('mcp:stripe:create_charge', {}, ctx)).content).toMatch(/^\[SENTINEL_DENIED\]/);
    expect(asked.map(a => a.options)).toEqual([['yes', 'no'], ['yes', 'no']]);
    expect(calls).toEqual([]);
  });

  it('the user deny rules still refuse in auto mode', async () => {
    setApprovalMode('auto');
    const perms = new PermissionEngine({ ...DEFAULT_CONFIG, security: { ...DEFAULT_CONFIG.security, denyRules: ['mcp:notes:'] } });
    const reg = registryWith(['notes', 'write_note']);
    const { ctx, asked } = makeCtx('yes', perms);
    const r = await reg.execute('mcp:notes:write_note', {}, ctx);
    expect(r.content).toMatch(/^\[PERMISSION_DENIED\]/);
    expect(asked).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});

describe('MCP "always yes"', () => {
  it('switches the session to auto — and a critical tool still asks the human', async () => {
    const reg = registryWith(['notes', 'write_note'], ['slack', 'post_message']);
    const { ctx, asked } = makeCtx(['always yes', 'no']);
    await reg.execute('mcp:notes:write_note', {}, ctx);
    expect(getApprovalMode()).toBe('auto');
    const r = await reg.execute('mcp:slack:post_message', {}, ctx);
    expect(r.content).toMatch(/^\[SENTINEL_DENIED\]/);
    expect(asked).toHaveLength(2);
    expect(asked[1].options).toEqual(['yes', 'no']);
    expect(calls).toEqual(['notes:write_note']);
  });
});
