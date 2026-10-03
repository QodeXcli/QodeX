import { describe, it, expect } from 'vitest';
import { AddProviderTool } from '../src/tools/builtin/add-provider.ts';

const ctx = {} as any;

describe('add_provider tool', () => {
  it('rejects an unknown provider without base_url/key_env — and writes nothing', async () => {
    const r = await new AddProviderTool().execute({ provider: 'mysteryllm-9000' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/base_url/);
    expect(r.content).toMatch(/key_env/);
  });

  it('is a mutating (permission-gated), chat-callable tool', () => {
    const t = new AddProviderTool();
    expect(t.name).toBe('add_provider');
    expect(t.isReadOnly).toBe(false);   // writes config → asks for permission
    expect(t.isDestructive).toBe(false); // reversible (qodex provider remove)
  });
});
