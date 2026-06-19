import { describe, it, expect } from 'vitest';
import { getRegistry } from '../src/tools/registry.js';

describe('tool name aliases', () => {
  const reg = getRegistry();

  it('resolves bash → shell', () => {
    expect(reg.has('bash')).toBe(true);
    expect(reg.get('bash')?.name).toBe('shell');
  });

  it('resolves run and other synonyms → shell', () => {
    for (const alias of ['run', 'sh', 'terminal', 'execute_command', 'cmd']) {
      expect(reg.get(alias)?.name, alias).toBe('shell');
    }
  });

  it('leaves a real tool name unchanged', () => {
    expect(reg.get('shell')?.name).toBe('shell');
    expect(reg.get('read_file')?.name).toBe('read_file');
  });

  it('does not invent a tool for a truly unknown name', () => {
    expect(reg.get('definitely_not_a_tool_xyz')).toBeUndefined();
  });

  it('execute() on an unknown name returns a helpful error', async () => {
    const r = await reg.execute('totally_unknown_zzz', {}, {} as any);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Unknown tool/);
  });
});
