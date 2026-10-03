/**
 * The `$` mods API on the real host: store (atomic, serialized, 4 MiB), process.run (argv,
 * no shell, timeout), fs (cwd-relative, 4 MiB), http (http/https only), command / tool
 * name rules, clock timers stop on unload, settings redaction, usage, and the UI bus.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ModApi } from '../src/mods/types.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mods-api-'));
const QHOME = path.join(ROOT, '.qodex');

let R: typeof import('../src/mods/runtime.js');
let BUS: typeof import('../src/mods/ui-bus.js');
let ST: typeof import('../src/mods/store.js');
let CR: typeof import('../src/mods/command-registry.js');
let cwd: string;

beforeAll(async () => {
  R = await import('../src/mods/runtime.js');
  BUS = await import('../src/mods/ui-bus.js');
  ST = await import('../src/mods/store.js');
  CR = await import('../src/mods/command-registry.js');
  (await import('../src/mods/paths.js')).setModsHomeForTesting(QHOME);
  cwd = fs.mkdtempSync(path.join(ROOT, 'cwd-'));
});

afterAll(async () => {
  R?.resetModsRuntimeForTesting();
  (await import('../src/mods/paths.js')).setModsHomeForTesting(null);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  R.resetModsRuntimeForTesting();
  BUS.resetModUiForTesting();
  ST.resetModStoreCacheForTesting();
  CR.clearModCommandsForTesting();
});

/** Load an inline mod and hand back its `$` (captured from a session.start hook). */
async function apiOf(name = 'probe', bindings: Record<string, unknown> = {}): Promise<{ $: ModApi; rt: import('../src/mods/runtime.js').ModsRuntime }> {
  const rt = await R.initMods({ cwd, surface: 'terminal', noBuiltins: true, bindings: bindings as any });
  let api: ModApi | null = null;
  await rt.addInlineMod(name, (on) => { on('session.start', ($, e, next) => { api = $; return next(e); }); });
  await rt.startSession('s-api', cwd);
  return { $: api!, rt };
}

describe('$.store', () => {
  it('persists JSON per mod with atomic, serialized writes', async () => {
    const { $ } = await apiOf('keeper');
    await Promise.all(Array.from({ length: 25 }, (_, i) => $.store.set(`k${i}`, { i, list: [i, i + 1] })));
    const file = ST.modStoreFile('keeper');
    const disk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Object.keys(disk)).toHaveLength(25);
    expect(disk.k7).toEqual({ i: 7, list: [7, 8] });
    expect(fs.readdirSync(path.dirname(file)).filter(f => f !== 'keeper.json')).toEqual([]); // no temp files left
    expect(await $.store.get('k3')).toEqual({ i: 3, list: [3, 4] });
    await $.store.delete('k3');
    expect(await $.store.get('k3')).toBeUndefined();
    expect((await $.store.keys()).length).toBe(24);
    // A returned value is a copy: mutating it changes nothing stored.
    const v = await $.store.get('k1') as { i: number };
    v.i = 99;
    expect(await $.store.get('k1')).toEqual({ i: 1, list: [1, 2] });
  });

  it('refuses more than 4 MiB and non-JSON values', async () => {
    const { $ } = await apiOf('big');
    await expect($.store.set('huge', 'x'.repeat(4 * 1024 * 1024 + 10))).rejects.toThrow(/exceed/);
    await expect($.store.set('fn', { f: BigInt(1) } as any)).rejects.toThrow(/not JSON/);
  });
});

describe('$.process.run', () => {
  it('runs an argument list with no shell; resolves whatever the exit code', async () => {
    const { $ } = await apiOf();
    const r = await $.process.run(['node', '-e', 'process.stdout.write(process.argv[1]); process.exit(3)', '$HOME; echo pwned']);
    expect(r).toEqual({ exitCode: 3, stdout: '$HOME; echo pwned', stderr: '' });
    const cwdOut = await $.process.run(['node', '-e', 'process.stdout.write(process.cwd())']);
    expect(fs.realpathSync(cwdOut.stdout)).toBe(fs.realpathSync(cwd));
    const echoed = await $.process.run(['node', '-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'piped in' });
    expect(echoed.stdout).toBe('piped in');
  });

  it('rejects a missing program, a bad argv and a timeout', async () => {
    const { $ } = await apiOf();
    await expect($.process.run(['qx-no-such-binary-xyz'])).rejects.toThrow(/not found/);
    await expect($.process.run('ls -la' as any)).rejects.toThrow(/list of strings/);
    await expect($.process.run(['node', '-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 })).rejects.toThrow(/still running after 200 ms/);
  });
});

describe('$.fs and $.http', () => {
  it('resolves relative paths against the session cwd and caps a file at 4 MiB', async () => {
    const { $ } = await apiOf();
    await $.fs.write('notes/a.md', '# hi');
    expect(fs.readFileSync(path.join(cwd, 'notes', 'a.md'), 'utf-8')).toBe('# hi');
    expect(await $.fs.read('notes/a.md')).toBe('# hi');
    expect(await $.fs.exists('notes/missing.md')).toBe(false);
    expect(await $.fs.list('notes')).toEqual([{ name: 'a.md', kind: 'file', size: 4 }]);
    await expect($.fs.write('big.txt', 'x'.repeat(4 * 1024 * 1024 + 1))).rejects.toThrow(/more than/);
    fs.writeFileSync(path.join(cwd, 'big.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect($.fs.read('big.bin')).rejects.toThrow(/larger than/);
  });

  it('http.fetch takes only http(s) URLs', async () => {
    const { $ } = await apiOf();
    await expect($.http.fetch('file:///etc/passwd')).rejects.toThrow(/only http and https/);
  });
});

describe('$.command / $.tool / $.ui', () => {
  it('command names: built-in, invalid and another mod\'s names are refused', async () => {
    const { $, rt } = await apiOf('first');
    await $.command.register({ name: 'deploy-check', description: 'Check', immediate: true });
    expect(CR.isImmediateModCommand('deploy-check')).toBe(true);
    await expect($.command.register({ name: 'compact', description: 'x' })).rejects.toThrow('"/compact" refused: it is the built-in /compact');
    await expect($.command.register({ name: 'mods', description: 'x' })).rejects.toThrow(/built-in/);
    await expect($.command.register({ name: 'bad name', description: 'x' })).rejects.toThrow(/letters, digits/);
    let other: ModApi | null = null;
    await rt.addInlineMod('second', (on) => { on('session.start', ($2, e, next) => { other = $2; return next(e); }); });
    await rt.startSession('s2', cwd);
    await expect(other!.command.register({ name: 'deploy-check', description: 'x' })).rejects.toThrow(/mod first already added it/);
    expect((await $.command.list()).find(c => c.name === 'deploy-check')).toEqual({ name: 'deploy-check', description: 'Check', source: 'mod:first' });
    rt.unload('first');
    expect(CR.getModCommand('deploy-check')).toBeUndefined();
  });

  it('tool.register needs a registry, a description and a short enough name', async () => {
    const { $ } = await apiOf('nore');
    await expect($.tool.register({ name: 'x', description: 'y', inputSchema: { type: 'object' } })).rejects.toThrow(/no tool registry/);
    R.resetModsRuntimeForTesting();
    const tools = new Map<string, any>();
    const registry = { get: (n: string) => tools.get(n), register: (t: any) => tools.set(t.name, t), list: () => [...tools.values()], unregisterByPrefix: (p: string) => { for (const k of [...tools.keys()]) if (k.startsWith(p)) tools.delete(k); return 0; } };
    const { $: $2, rt } = await apiOf('withreg', { registry });
    await expect($2.tool.register({ name: 'x', description: ' ', inputSchema: { type: 'object' } })).rejects.toThrow(/needs a description/);
    await expect($2.tool.register({ name: 'n'.repeat(60), description: 'd', inputSchema: { type: 'object' } })).rejects.toThrow(/longer than 64/);
    await $2.tool.register({ name: 'lookup', description: 'Look a ticket up', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } });
    expect(await $2.tool.list()).toEqual(['mod__withreg__lookup']);
    expect(tools.get('mod__withreg__lookup').schema().function).toMatchObject({ name: 'mod__withreg__lookup', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: [] } });
    rt.unload('withreg');
    expect(tools.size).toBe(0);
  });

  it('ui calls reach the bus with the mod name; the backlog replays to the first subscriber', async () => {
    const { $ } = await apiOf('shower');
    $.ui.log('built in 3s');
    $.ui.notice('a test is failing');
    $.ui.status('3 checks\nrunning');
    $.ui.toast('saved', { timeoutMs: 1000 });
    const seen: any[] = [];
    const unsub = BUS.subscribeModUi(ev => seen.push(ev));
    expect(seen).toEqual([
      { kind: 'log', plugin: 'shower', text: 'built in 3s' },
      { kind: 'notice', plugin: 'shower', text: 'a test is failing' },
      { kind: 'status', plugin: 'shower', text: '3 checks running' },
      { kind: 'toast', plugin: 'shower', text: 'saved', timeoutMs: 1000 },
    ]);
    expect(BUS.modStatusLines()).toEqual([{ plugin: 'shower', text: '3 checks running' }]);
    $.ui.status(null);
    expect(BUS.modStatusLines()).toEqual([]);
    unsub();
  });

  it('invalidate is coalesced to at most 10 redraws a second', async () => {
    const { $ } = await apiOf('drawer');
    const seen: any[] = [];
    const unsub = BUS.subscribeModUi(ev => { if (ev.kind === 'invalidate') seen.push(ev); });
    for (let i = 0; i < 50; i++) $.ui.invalidate();
    await new Promise(r => setTimeout(r, 250));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThanOrEqual(3);
    expect(seen[0]).toEqual({ kind: 'invalidate', plugin: 'drawer' });
    unsub();
  });

  it('ui.open needs a surface that draws panes; ids belong to one mod', async () => {
    const { $ } = await apiOf('paner');
    expect(await $.ui.open({ id: 'p1' })).toMatchObject({ isPlaced: false });
    const unsub = BUS.subscribeModUi(() => undefined, { panes: true });
    expect(await $.ui.open({ id: 'p1', title: 'One', rows: 500 })).toEqual({ isPlaced: true });
    expect(BUS.modOpenPanes()).toEqual([{ plugin: 'paner', id: 'p1', title: 'One', rows: 60 }]);
    expect(await $.ui.open({ id: 'bad id' })).toMatchObject({ isPlaced: false });
    await $.ui.close({ id: 'p1' });
    expect(BUS.modOpenPanes()).toEqual([]);
    unsub();
  });
});

describe('$.model.complete', () => {
  it('routes fast / default / an id, falls back for an unknown alias, and never rejects on errors', async () => {
    const seen: Array<{ model: string; maxTokens?: number; system?: string }> = [];
    const provider = {
      name: 'fake',
      async *complete(req: any) {
        seen.push({ model: req.model, maxTokens: req.maxTokens, system: req.messages[0]?.role === 'system' ? req.messages[0].content : undefined });
        if (req.messages.at(-1).content === 'fail') { yield { type: 'error', error: 'rate limited' }; return; }
        yield { type: 'text_delta', delta: `answer from ${req.model}` };
        yield { type: 'done' };
      },
    };
    const router = {
      route: (_c: any, _t: number, o: { explicitModel?: string } = {}) => {
        if (o.explicitModel === 'haiku') throw new Error('Model not available: haiku');
        return { provider, model: o.explicitModel ?? 'main-model', modelInfo: {} };
      },
    };
    const config = { defaults: { model: 'main-model' }, roles: { offload: { provider: 'ollama', model: 'small-model' } } };
    const { $ } = await apiOf('asker', { router, config });
    expect(await $.model.complete({ prompt: 'hi', model: 'fast', system: 'be brief' })).toEqual({ isAnswered: true, text: 'answer from small-model' });
    expect(seen[0]).toEqual({ model: 'small-model', maxTokens: 1024, system: 'be brief' });
    expect(await $.model.complete({ prompt: 'hi' })).toEqual({ isAnswered: true, text: 'answer from main-model' });
    expect(await $.model.complete({ prompt: 'hi', model: 'haiku', maxTokens: 50 })).toEqual({ isAnswered: true, text: 'answer from small-model' });
    expect(seen.at(-1)?.maxTokens).toBe(50);
    expect(await $.model.complete({ prompt: 'fail' })).toEqual({ isAnswered: false, reason: 'rate limited' });
    expect(await $.model.complete({ prompt: '  ' })).toMatchObject({ isAnswered: false });
  });
});

describe('$.clock, $.settings, $.session', () => {
  it('timers stop when the mod unloads; later calls are refused', async () => {
    const { $, rt } = await apiOf('ticker');
    let ticks = 0;
    $.clock.every(60, () => { ticks++; });
    let fired = false;
    $.clock.after(80, () => { fired = true; });
    await new Promise(r => setTimeout(r, 200));
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(fired).toBe(true);
    rt.unload('ticker');
    const at = ticks;
    await new Promise(r => setTimeout(r, 200));
    expect(ticks).toBe(at);
    await expect($.store.get('x')).rejects.toThrow(/unloaded/);
  });

  it('a throwing timer callback is reported, and the timer keeps running', async () => {
    const { $ } = await apiOf('flaky');
    const errs: string[] = [];
    const unsub = BUS.subscribeModUi(ev => { if (ev.kind === 'error') errs.push(ev.text); });
    let n = 0;
    const t = $.clock.every(50, () => { n++; throw new Error('tick broke'); });
    await new Promise(r => setTimeout(r, 180));
    t.cancel();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(errs[0]).toMatch(/timer callback threw tick broke/);
    unsub();
  });

  it('settings.read redacts secrets; session.usage has the documented shape', async () => {
    const config = { defaults: { model: 'm1', maxIterations: 50 }, providers: { anthropic: { apiKey: 'sk-ant-secret' } }, budget: { perTaskMaxTokens: 1000, perTaskLimitUsd: 0, perTaskMaxWallSeconds: 0 }, telegram: { botToken: 'abc' } };
    const { $, rt } = await apiOf('reader', { config });
    const s = await $.settings.read() as any;
    expect(s.providers.anthropic.apiKey).toBe('[redacted]');
    expect(s.telegram.botToken).toBe('[redacted]');
    expect(s.defaults.model).toBe('m1');
    rt.lastRun = {
      messages: [
        { role: 'system', content: 'You are QodeX.\n\n# Project Rules (from QODEX.md)\nuse pnpm\n\n# Memory (from past sessions)\nfacts' },
        { role: 'user', content: 'hello there' },
        { role: 'tool', content: 'result text', tool_call_id: 'c1' } as any,
      ],
      budget: { tokens: 500, contextWindow: 10_000, lastInputTokens: 2_000, iterations: 3 },
    };
    const u = await $.session.usage();
    expect(u.context).toMatchObject({ tokens: 2_000, window: 10_000, percent: 20 });
    const cats = Object.fromEntries(u.context.byCategory.map(c => [c.category, c.tokens]));
    expect(Object.keys(cats).sort()).toEqual(['free', 'memory', 'messages', 'rules', 'system', 'tool-results', 'tools']);
    expect(cats.free).toBe(8_000);
    expect(cats.rules).toBeGreaterThan(0);
    expect(u.limits).toEqual([
      { kind: 'tokens', used: 500, limit: 1000, percentUsed: 50 },
      { kind: 'iterations', used: 3, limit: 50, percentUsed: 6 },
    ]);
    expect($.session.id()).toBe('s-api');
    expect($.session.cwd()).toBe(cwd);
  });
});
