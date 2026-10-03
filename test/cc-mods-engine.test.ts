/**
 * Mods engine: chain order, matchers, frozen payloads, failure handling (throw / timeout /
 * bad shape → skipped), .catch, '*' hooks and own-time accounting.
 */
import { describe, it, expect } from 'vitest';
import { ModEngine, untimed, matchesMatcher, type HookFailure } from '../src/mods/engine.js';

const api = {} as any;

function engineWith(): { engine: ModEngine; failures: HookFailure[] } {
  const engine = new ModEngine();
  const failures: HookFailure[] = [];
  engine.onHookError = f => failures.push(f);
  return { engine, failures };
}

describe('chain order', () => {
  it('runs user, then project, then builtin mods; ties by name; hooks in on() order', async () => {
    const { engine } = engineWith();
    const seen: string[] = [];
    const mk = (name: string, rank: number) => {
      const on = engine.addMod(name, rank, api);
      on('turn.start', async ($, e, next) => { seen.push(`${name}:1`); return next(e); });
      on('turn.start', { turn: 1 }, async ($, e, next) => { seen.push(`${name}:2`); return next(e); });
    };
    mk('zbuiltin', 2);
    mk('bproject', 1);
    mk('buser', 0);
    mk('auser', 0);
    let reached = false;
    await engine.emit('turn.start', { turn: 1, prompt: 'x' }, () => { reached = true; });
    expect(seen).toEqual(['auser:1', 'auser:2', 'buser:1', 'buser:2', 'bproject:1', 'bproject:2', 'zbuiltin:1', 'zbuiltin:2']);
    expect(reached).toBe(true);
    expect(engine.modNames()).toEqual(['auser', 'buser', 'bproject', 'zbuiltin']);
  });

  it('a result without next answers the event: later mods and the terminal do not run', async () => {
    const { engine } = engineWith();
    const late: string[] = [];
    engine.addMod('a', 0, api)('tool.call', async () => ({ deny: 'no' }));
    engine.addMod('b', 0, api)('tool.call', async ($, e, next) => { late.push('b'); return next(e); });
    let ran = false;
    const r = await engine.emit('tool.call', { tool: 'shell', args: {}, callId: '1', cwd: '/' }, () => { ran = true; return { result: 'x' }; });
    expect(r.result).toEqual({ deny: 'no' });
    expect(late).toEqual([]);
    expect(ran).toBe(false);
  });

  it('returning nothing without calling next passes the event on', async () => {
    const { engine } = engineWith();
    engine.addMod('a', 0, api)('tool.call', () => undefined);
    const r = await engine.emit('tool.call', { tool: 't', args: {}, callId: '1', cwd: '/' }, () => ({ result: 'ran' }));
    expect(r.result).toEqual({ result: 'ran' });
  });

  it('awaiting next and returning nothing keeps what next resolved to', async () => {
    const { engine } = engineWith();
    engine.addMod('a', 0, api)('tool.call', async ($, e, next) => { await next(e); });
    const r = await engine.emit('tool.call', { tool: 't', args: {}, callId: '1', cwd: '/' }, () => ({ result: 'ran' }));
    expect(r.result).toEqual({ result: 'ran' });
  });
});

describe('payloads', () => {
  it('e is deeply frozen and next(copy) rewrites what later hooks and the terminal see', async () => {
    const { engine } = engineWith();
    let frozenErr = '';
    engine.addMod('a', 0, api)('tool.call', async ($, e, next) => {
      try { (e.args as any).cmd = 'x'; } catch (err: any) { frozenErr = err.message; }
      return next({ ...e, args: { ...e.args, cmd: 'rewritten' } });
    });
    let laterSaw: unknown;
    engine.addMod('b', 1, api)('tool.call', async ($, e, next) => { laterSaw = e.args.cmd; return next(e); });
    let terminalSaw: any;
    const r = await engine.emit('tool.call', { tool: 't', args: { cmd: 'orig' }, callId: '1', cwd: '/' }, (e) => { terminalSaw = e; e.args.mutable = true; return { result: 'ok' }; });
    expect(frozenErr).toMatch(/read only|read-only|Cannot assign/i);
    expect(laterSaw).toBe('rewritten');
    expect(terminalSaw.args.cmd).toBe('rewritten');
    expect(r.payload.args.cmd).toBe('rewritten');
    expect(r.result).toEqual({ result: 'ok' });
  });

  it('matchers: value, list and RegExp; checked against the current payload', async () => {
    expect(matchesMatcher({ tool: 'shell' }, { tool: 'shell' })).toBe(true);
    expect(matchesMatcher({ tool: ['a', 'b'] }, { tool: 'b' })).toBe(true);
    expect(matchesMatcher({ tool: ['a', 'b'] }, { tool: 'c' })).toBe(false);
    expect(matchesMatcher({ tool: /^mcp__/ }, { tool: 'mcp__x__y' })).toBe(true);
    expect(matchesMatcher({ tool: /^mcp__/ }, { tool: 'shell' })).toBe(false);
    expect(matchesMatcher({ tool: 'shell', callId: '2' }, { tool: 'shell', callId: '1' })).toBe(false);
    const { engine } = engineWith();
    const hits: string[] = [];
    const on = engine.addMod('a', 0, api);
    on('tool.call', { tool: 'write_file' }, async ($, e, next) => { hits.push('write'); return next(e); });
    on('tool.call', { tool: ['shell', 'bash'] }, async ($, e, next) => { hits.push('shell'); return next(e); });
    await engine.emit('tool.call', { tool: 'shell', args: {}, callId: '1', cwd: '/' }, () => ({ result: '' }));
    expect(hits).toEqual(['shell']);
  });

  it("'*' hooks see every event", async () => {
    const { engine } = engineWith();
    const seen: string[] = [];
    engine.addMod('a', 0, api)('*', async ($, e, next) => { seen.push(Object.keys(e).join(',')); return next(e); });
    expect(engine.has('turn.complete')).toBe(true);
    await engine.emit('turn.start', { turn: 1, prompt: 'p' });
    await engine.emit('session.compact', { sessionId: 's', tokens: 5 });
    expect(seen).toEqual(['turn,prompt', 'sessionId,tokens']);
  });
});

describe('failures', () => {
  it('a throwing hook is skipped and the chain continues with the event as it was', async () => {
    const { engine, failures } = engineWith();
    engine.addMod('bad', 0, api)('tool.call', async () => { throw new Error('boom'); });
    const r = await engine.emit('tool.call', { tool: 't', args: { a: 1 }, callId: '1', cwd: '/' }, (e) => ({ result: `ran ${e.args.a}` }));
    expect(r.result).toEqual({ result: 'ran 1' });
    expect(failures).toEqual([{ plugin: 'bad', event: 'tool.call', kind: 'throw', message: 'threw Error: boom' }]);
  });

  it('a hook that fails after next resolved keeps that result (nothing runs twice)', async () => {
    const { engine } = engineWith();
    let runs = 0;
    engine.addMod('bad', 0, api)('tool.call', async ($, e, next) => { await next(e); throw new Error('after'); });
    const r = await engine.emit('tool.call', { tool: 't', args: {}, callId: '1', cwd: '/' }, () => { runs++; return { result: 'once' }; });
    expect(runs).toBe(1);
    expect(r.result).toEqual({ result: 'once' });
  });

  it('a hook over its own-time limit is skipped; a late next() from it does not run the chain', async () => {
    const { engine, failures } = engineWith();
    engine.hookMs = 60;
    let late: Promise<unknown> | null = null;
    engine.addMod('slow', 0, api)('tool.call', async ($, e, next) => {
      await new Promise(r => setTimeout(r, 150));
      late = next(e);
      return late;
    });
    let runs = 0;
    const r = await engine.emit('tool.call', { tool: 't', args: {}, callId: '1', cwd: '/' }, () => { runs++; return { result: 'x' }; });
    expect(r.result).toEqual({ result: 'x' });
    expect(failures[0]).toMatchObject({ plugin: 'slow', kind: 'timeout' });
    await new Promise(r => setTimeout(r, 150));
    await expect(late!).rejects.toThrow(/skipped/);
    expect(runs).toBe(1);
  });

  it('time inside next and inside $ calls does not count against the hook', async () => {
    const { engine, failures } = engineWith();
    engine.hookMs = 80;
    engine.addMod('outer', 0, api)('tool.call', async ($, e, next) => {
      await untimed(() => new Promise(r => setTimeout(r, 120))); // a slow $ call
      return next(e);
    });
    const r = await engine.emit('tool.call', { tool: 't', args: {}, callId: '1', cwd: '/' }, async () => {
      await new Promise(r => setTimeout(r, 120)); // slow QodeX behavior inside next
      return { result: 'done' };
    });
    expect(r.result).toEqual({ result: 'done' });
    expect(failures).toEqual([]);
  });

  it('a result of the wrong shape is skipped like a throw', async () => {
    const { engine, failures } = engineWith();
    engine.addMod('odd', 0, api)('tool.check', async () => ({ decision: 'maybe' }) as any);
    const r = await engine.emit('tool.check', { tool: 't', operation: 'o', decision: 'ask' }, (e) => ({ decision: e.decision }));
    expect(r.result).toEqual({ decision: 'ask' });
    expect(failures[0]?.message).toMatch(/wrong shape/);
  });

  it('.catch answers in the failed hook\'s place (fail closed)', async () => {
    const { engine } = engineWith();
    let info: any;
    engine.addMod('guard', 0, api)('tool.call', async () => { throw new Error('guard broke'); })
      .catch((err: any, _e: any, next: any) => { info = { kind: err.kind, nextKind: next.error.kind, called: next.called }; return { deny: `guard failed: ${err.kind}` } as any; });
    let ran = false;
    const r = await engine.emit('tool.call', { tool: 't', args: {}, callId: '1', cwd: '/' }, () => { ran = true; return { result: 'x' }; });
    expect(r.result).toEqual({ deny: 'guard failed: throw' });
    expect(info).toEqual({ kind: 'throw', nextKind: 'throw', called: false });
    expect(ran).toBe(false);
  });

  it('an error thrown by QodeX itself (the terminal) propagates and is not blamed on the mod', async () => {
    const { engine, failures } = engineWith();
    engine.addMod('obs', 0, api)('tool.call', async ($, e, next) => next(e));
    await expect(engine.emit('tool.call', { tool: 't', args: {}, callId: '1', cwd: '/' }, () => { throw new Error('qodex failed'); }))
      .rejects.toThrow('qodex failed');
    expect(failures).toEqual([]);
  });

  it('next.signal aborts with the event; next.budget reports the limit', async () => {
    const { engine } = engineWith();
    let aborted = false;
    let budget = 0;
    engine.addMod('a', 0, api)('turn.start', async ($, e, next) => {
      budget = next.budget.ms;
      next.signal.addEventListener('abort', () => { aborted = true; });
      return next(e);
    });
    const ac = new AbortController();
    await engine.emit('turn.start', { turn: 1, prompt: '' }, () => { ac.abort(); }, { signal: ac.signal });
    expect(aborted).toBe(true);
    expect(budget).toBe(10_000);
  });

  it('warns about unknown events and duplicate bare hooks without failing the load', () => {
    const { engine } = engineWith();
    const on = engine.addMod('w', 0, api) as any;
    on('classic.Stop', () => undefined);
    on('session.start', () => undefined);
    on('session.start', () => undefined);
    expect(engine.warningsOf('w').join('\n')).toMatch(/classic.Stop.*never fires[\s\S]*registered twice/);
  });
});
