import { describe, it, expect } from 'vitest';
import { keyGuidance, webKeyStatus, missingWebKeysGuidance, findServiceKey, WEB_SERVICE_KEYS } from '../src/setup/key-guidance.ts';
import { computeHealth } from '../src/cli/dashboard-observability.ts';
import { SaveApiKeyTool } from '../src/tools/builtin/save-api-key.ts';

describe('key guidance — actionable, never a dead end', () => {
  it('per-key guidance names the signup URL, the env var, and the paste-in-chat option', () => {
    const g = keyGuidance('FIRECRAWL_API_KEY');
    expect(g).toContain('firecrawl.dev');
    expect(g).toContain('free tier');
    expect(g).toContain('FIRECRAWL_API_KEY=');
    expect(g).toMatch(/paste the key here in chat/);
    expect(g).toContain('~/.qodex/.env');
  });

  it('webKeyStatus splits set vs missing', () => {
    const s = webKeyStatus({ TAVILY_API_KEY: 'tvly-x' });
    expect(s.set.map(k => k.env)).toEqual(['TAVILY_API_KEY']);
    expect(s.missing).toHaveLength(WEB_SERVICE_KEYS.length - 1);
  });

  it('missingWebKeysGuidance fires ONLY when no content-grade key is set', () => {
    const none = missingWebKeysGuidance({});
    expect(none).toMatch(/no search API key is set/);
    expect(none).toContain('https://www.firecrawl.dev');
    expect(none).toContain('https://app.tavily.com');
    expect(none).toMatch(/paste a key here in chat/);
    expect(missingWebKeysGuidance({ FIRECRAWL_API_KEY: 'fc-x' })).toBeNull();   // one key → no nag
  });

  it('findServiceKey resolves known env names', () => {
    expect(findServiceKey('TAVILY_API_KEY')!.service).toBe('Tavily');
    expect(findServiceKey('NOT_A_KEY')).toBeUndefined();
  });
});

describe('health badge — web search readiness', () => {
  const base = { providers: [], schedulesEnabled: 0, botRunning: false, modelSet: true };
  it('warns with a concrete suggestion when zero keys are set', () => {
    const items = computeHealth({ ...base, webKeys: { set: 0, total: 3, suggest: { service: 'Firecrawl', env: 'FIRECRAWL_API_KEY', url: 'https://www.firecrawl.dev' } } });
    const w = items.find(i => i.label === 'Web search')!;
    expect(w.ok).toBe(false);
    expect(w.detail).toContain('keyless fallback only');
    expect(w.detail).toContain('firecrawl.dev');
  });
  it('is green once any key is set; absent input → no badge (back-compat)', () => {
    const w = computeHealth({ ...base, webKeys: { set: 1, total: 3 } }).find(i => i.label === 'Web search')!;
    expect(w.ok).toBe(true);
    expect(computeHealth(base).find(i => i.label === 'Web search')).toBeUndefined();
  });
});

describe('save_api_key — input validation (no I/O paths)', () => {
  const tool = new SaveApiKeyTool();
  it('rejects a bad env-var name, a too-short value, and whitespace pastes', async () => {
    expect((await tool.execute({ env_var: 'bad name!', value: 'x'.repeat(20) }, {} as any)).isError).toBe(true);
    expect((await tool.execute({ env_var: 'TAVILY_API_KEY', value: 'short' }, {} as any)).isError).toBe(true);
    const ws = await tool.execute({ env_var: 'TAVILY_API_KEY', value: 'abc def ghij klmno' }, {} as any);
    expect(ws.isError).toBe(true);
    expect(ws.content).toMatch(/whitespace/);
  });
  it('never echoes the value back in any error message', async () => {
    const r = await tool.execute({ env_var: 'bad name!', value: 'SUPER-SECRET-VALUE-123' }, {} as any);
    expect(r.content).not.toContain('SUPER-SECRET-VALUE-123');
  });
});
