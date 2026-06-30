import { describe, it, expect } from 'vitest';
import { validateConfigSet, setDeep, getDeep, dispatchAction, CONFIG_KNOBS } from '../src/cli/dashboard-control.ts';
import { handleRequest } from '../src/cli/dashboard-server.ts';

describe('validateConfigSet — strict whitelist + coercion', () => {
  it('rejects a non-whitelisted key (no arbitrary config writes)', () => {
    const r = validateConfigSet('providers.anthropic.apiKeyEnv', 'HAXX');
    expect(r.ok).toBe(false);
  });
  it('coerces bool knobs from real bools and strings', () => {
    expect(validateConfigSet('context.efficient', true)).toEqual({ ok: true, coerced: true });
    expect(validateConfigSet('context.efficient', 'false')).toEqual({ ok: true, coerced: false });
    expect((validateConfigSet('context.efficient', 'maybe') as any).ok).toBe(false);
  });
  it('validates enum knobs against their allowed values', () => {
    expect(validateConfigSet('memory.mode', 'lightweight')).toEqual({ ok: true, coerced: 'lightweight' });
    expect((validateConfigSet('memory.mode', 'turbo') as any).ok).toBe(false);
  });
  it('every knob is bool or enum-with-values', () => {
    for (const k of CONFIG_KNOBS) {
      if (k.type === 'enum') expect(Array.isArray(k.values) && k.values.length).toBeTruthy();
    }
  });
});

describe('setDeep / getDeep', () => {
  it('sets and reads a dotted path, creating intermediates', () => {
    const o: any = {};
    setDeep(o, 'a.b.c', 5);
    expect(o).toEqual({ a: { b: { c: 5 } } });
    expect(getDeep(o, 'a.b.c')).toBe(5);
    expect(getDeep(o, 'a.x.y')).toBeUndefined();
    expect(getDeep(undefined, 'a')).toBeUndefined();
  });
  it('does not clobber a sibling', () => {
    const o: any = { a: { keep: 1 } };
    setDeep(o, 'a.b', 2);
    expect(o.a).toEqual({ keep: 1, b: 2 });
  });
});

describe('dispatchAction — unknown + validation rejection (no disk writes)', () => {
  it('rejects an unknown action', async () => {
    expect(await dispatchAction('rm -rf', {}, '/tmp')).toEqual({ ok: false, message: 'Unknown action "rm -rf".' });
  });
  it('rejects config.set for a non-whitelisted key without writing', async () => {
    const r = await dispatchAction('config.set', { key: 'providers.openai.apiKeyEnv', value: 'x' }, '/tmp');
    expect(r.ok).toBe(false);
  });
  it('memory.forget needs a substring', async () => {
    expect((await dispatchAction('memory.forget', { substring: '' }, '/tmp')).ok).toBe(false);
  });
});

describe('handleRequest — token auth + routing', () => {
  const deps = { cwd: '/tmp', renderHtml: async () => '<html>dash</html>', getState: async () => ({ ok: 1 }) };

  it('401s without a valid token (protects the mutating API)', async () => {
    const r = await handleRequest({ method: 'GET', pathname: '/', tokenOk: false, body: undefined, ...deps });
    expect(r.status).toBe(401);
  });
  it('serves the HTML on GET / when authed', async () => {
    const r = await handleRequest({ method: 'GET', pathname: '/', tokenOk: true, body: undefined, ...deps });
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
    expect(r.body).toContain('dash');
  });
  it('returns state JSON on GET /api/state', async () => {
    const r = await handleRequest({ method: 'GET', pathname: '/api/state', tokenOk: true, body: undefined, ...deps });
    expect(JSON.parse(r.body)).toEqual({ ok: true, state: { ok: 1 } });
  });
  it('dispatches POST /api/action and reflects the result status', async () => {
    const r = await handleRequest({ method: 'POST', pathname: '/api/action', tokenOk: true, body: { action: 'nope' }, ...deps });
    expect(r.status).toBe(400);                  // unknown action → ok:false → 400
    expect(JSON.parse(r.body).ok).toBe(false);
  });
  it('404s an unknown path', async () => {
    const r = await handleRequest({ method: 'GET', pathname: '/secret', tokenOk: true, body: undefined, ...deps });
    expect(r.status).toBe(404);
  });
});
