import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scaffoldMcpServer } from '../src/mcp/scaffold/builder.js';
import { McpScaffoldTool } from '../src/tools/mcp-builder/scaffold-tool.js';
import type { ToolContext } from '../src/tools/base.js';

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: 'test',
    transaction: {} as any,
    permissions: { check: () => ({ ok: true }) } as any,
    askUser: async () => 'allow',
    signal: new AbortController().signal,
    emit: () => {},
  } as ToolContext;
}

describe('scaffoldMcpServer', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-mcpscaf-'));
  });

  it('writes the expected files', async () => {
    const dir = path.join(tmp, 'weather-mcp');
    const r = await scaffoldMcpServer({ dir, name: 'weather-mcp', description: 'Forecast tool', transport: 'stdio' });
    expect(r.filesWritten).toContain('package.json');
    expect(r.filesWritten).toContain('tsconfig.json');
    expect(r.filesWritten).toContain('README.md');
    expect(r.filesWritten).toContain('src/index.ts');
    expect(r.filesWritten).toContain('src/tools/example.ts');
    expect(r.filesWritten).toContain('test/example.test.ts');
  });

  it('substitutes variables in templates', async () => {
    const dir = path.join(tmp, 'cool-mcp');
    await scaffoldMcpServer({ dir, name: 'cool-mcp', description: 'Cool things', transport: 'stdio' });
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('cool-mcp');
    expect(pkg.description).toBe('Cool things');
    expect(pkg.bin['cool-mcp']).toBe('./dist/index.js');
    const index = await fs.readFile(path.join(dir, 'src/index.ts'), 'utf-8');
    expect(index).toContain("name: 'cool-mcp'");
    expect(index).not.toContain('{{NAME}}');
    expect(index).not.toContain('{{ABSOLUTE_DIST_PATH}}');
  });

  it('refuses non-empty target by default', async () => {
    const dir = path.join(tmp, 'busy');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'README.md'), 'existing');
    await expect(scaffoldMcpServer({ dir, name: 'busy', description: 'd', transport: 'stdio' }))
      .rejects.toThrow(/not empty/i);
  });

  it('overwrites when explicit', async () => {
    const dir = path.join(tmp, 'over');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'README.md'), 'existing');
    const r = await scaffoldMcpServer(
      { dir, name: 'over', description: 'd', transport: 'stdio' },
      { overwrite: true },
    );
    expect(r.filesWritten.length).toBeGreaterThan(0);
    const newReadme = await fs.readFile(path.join(dir, 'README.md'), 'utf-8');
    expect(newReadme).not.toBe('existing');
  });

  it('validates name', async () => {
    await expect(scaffoldMcpServer({ dir: tmp + '/x', name: 'Bad Name', description: 'd', transport: 'stdio' }))
      .rejects.toThrow(/invalid name/i);
    await expect(scaffoldMcpServer({ dir: tmp + '/x', name: '1name', description: 'd', transport: 'stdio' }))
      .rejects.toThrow(/invalid name/i);
  });

  it('produces a valid config snippet', async () => {
    const dir = path.join(tmp, 'snip');
    const r = await scaffoldMcpServer({ dir, name: 'snip', description: 'd', transport: 'stdio' });
    expect(r.configSnippet).toContain('snip:');
    expect(r.configSnippet).toContain('command: node');
    expect(r.configSnippet).toContain(path.join(dir, 'dist') + '/index.js');
    expect(r.configSnippet).toContain('enabled: true');
  });
});

describe('mcp_scaffold tool', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-mcptool-'));
  });

  it('writes into cwd/<name> by default', async () => {
    const tool = new McpScaffoldTool();
    const r = await tool.execute({ name: 'auto', description: 'Auto thing' } as any, makeCtx(tmp));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Scaffolded MCP server "auto"');
    expect(await fs.stat(path.join(tmp, 'auto', 'package.json'))).toBeTruthy();
  });

  it('surfaces scaffold errors cleanly', async () => {
    const tool = new McpScaffoldTool();
    const r = await tool.execute({ name: 'BadName', description: 'd' } as any, makeCtx(tmp));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('MCP_SCAFFOLD_ERROR');
  });

  it('honours explicit dir', async () => {
    const target = path.join(tmp, 'nested', 'place');
    const tool = new McpScaffoldTool();
    const r = await tool.execute({ name: 'place', description: 'd', dir: target } as any, makeCtx(tmp));
    expect(r.isError).toBeFalsy();
    expect(await fs.stat(path.join(target, 'src', 'index.ts'))).toBeTruthy();
  });
});
