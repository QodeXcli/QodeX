import { describe, it, expect, beforeAll } from 'vitest';
import { QodexMcpServer } from '../src/mcp/server/server.js';
import { getRegistry } from '../src/tools/registry.js';

describe('QodexMcpServer protocol', () => {
  let server: QodexMcpServer;

  beforeAll(() => {
    const registry = getRegistry();
    server = new QodexMcpServer({ registry, config: {} as any, cwd: process.cwd() });
  });

  it('responds to initialize with protocol version + serverInfo', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res).not.toBeNull();
    expect((res!.result as any).serverInfo.name).toBe('qodex');
    expect((res!.result as any).protocolVersion).toBeTruthy();
  });

  it('returns null (no response) for the initialized notification', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: null as any, method: 'notifications/initialized' });
    expect(res).toBeNull();
  });

  it('answers ping with empty result', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(res!.result).toEqual({});
  });

  it('lists tools including the qodex_* specials', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = (res!.result as any).tools as Array<{ name: string; inputSchema: any }>;
    const names = tools.map(t => t.name);
    expect(names).toContain('qodex_hybrid_search');
    expect(names).toContain('qodex_critic_review');
    expect(names).toContain('qodex_sandbox_run');
    // every tool has a valid object inputSchema
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('errors on tools/call with no name', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} });
    expect(res!.error).toBeDefined();
    expect(res!.error!.code).toBe(-32602);
  });

  it('errors on unknown method', async () => {
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'frobnicate' });
    expect(res!.error!.code).toBe(-32601);
  });

  it('hybrid_search validates a missing query', async () => {
    const res = await server.handleMessage({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'qodex_hybrid_search', arguments: {} },
    });
    const result = res!.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/query is required/);
  });
});

describe('QodexMcpServer exposure scope', () => {
  const registry = getRegistry();

  it("'safe' scope exposes only read-only tools + specials", async () => {
    const s = new QodexMcpServer({ registry, config: {} as any, cwd: process.cwd(), exposeTools: 'safe' });
    const res = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (res!.result as any).tools.map((t: any) => t.name);
    expect(names).toContain('qodex_hybrid_search');
    // write_file is NOT read-only → must be hidden in safe scope
    expect(names).not.toContain('write_file');
  });

  it("'all' scope exposes mutating tools too", async () => {
    const s = new QodexMcpServer({ registry, config: {} as any, cwd: process.cwd(), exposeTools: 'all' });
    const res = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (res!.result as any).tools.map((t: any) => t.name);
    expect(names).toContain('write_file');
  });

  it('explicit allowlist exposes exactly those (plus specials)', async () => {
    const s = new QodexMcpServer({ registry, config: {} as any, cwd: process.cwd(), exposeTools: ['grep'] });
    const res = await s.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (res!.result as any).tools.map((t: any) => t.name);
    expect(names).toContain('grep');
    expect(names).toContain('qodex_hybrid_search'); // specials always
    expect(names).not.toContain('read_file');
  });

  it('rejects a tools/call for a tool outside the scope', async () => {
    const s = new QodexMcpServer({ registry, config: {} as any, cwd: process.cwd(), exposeTools: ['grep'] });
    const res = await s.handleMessage({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'write_file', arguments: { path: 'x', content: 'y' } },
    });
    const result = res!.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/scope-restricted/);
  });
});
