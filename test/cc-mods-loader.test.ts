/**
 * Mods loader: both layouts, TypeScript entries, bad manifests, trust gating (and a
 * changed hash needing re-trust), enable / disable state, shadowing, built-in defaults,
 * userConfig options, hot reload of a user mod.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mods-loader-'));
const QHOME = path.join(ROOT, '.qodex');

let L: typeof import('../src/mods/loader.js');
let R: typeof import('../src/mods/runtime.js');
let C: typeof import('../src/mods/command.js');
let BUS: typeof import('../src/mods/ui-bus.js');
let CR: typeof import('../src/mods/command-registry.js');
let cwd: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A mod that registers a command named after itself and answers it with `reply`. */
function qodexMod(dir: string, name: string, reply = 'v1', extra: Record<string, unknown> = {}): void {
  write(path.join(dir, 'mod.json'), JSON.stringify({ name, description: `${name} mod`, ...extra }));
  write(path.join(dir, 'register.js'), `
export function register(on, options) {
  on('session.start', async ($, e, next) => { await $.command.register({ name: '${name}-cmd', description: 'x' }); return next(e); });
  on('command.run', { command: '${name}-cmd' }, () => ({ text: '${reply}' + (options.suffix ?? '') }));
}
`);
}

beforeAll(async () => {
  L = await import('../src/mods/loader.js');
  R = await import('../src/mods/runtime.js');
  C = await import('../src/mods/command.js');
  BUS = await import('../src/mods/ui-bus.js');
  CR = await import('../src/mods/command-registry.js');
  (await import('../src/mods/paths.js')).setModsHomeForTesting(QHOME);
});

afterAll(async () => {
  R?.resetModsRuntimeForTesting();
  (await import('../src/mods/paths.js')).setModsHomeForTesting(null);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

afterEach(() => {
  R.resetModsRuntimeForTesting();
  BUS.resetModUiForTesting();
  CR.clearModCommandsForTesting();
  fs.rmSync(QHOME, { recursive: true, force: true });
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
});

function freshCwd(): string {
  cwd = fs.mkdtempSync(path.join(ROOT, 'cwd-'));
  return cwd;
}

describe('manifests and layouts', () => {
  it('reads mod.json + register.js and the Claude Code plugin layout', async () => {
    const a = path.join(ROOT, 'layout-a');
    qodexMod(a, 'alpha');
    const m1 = await L.readModManifest(a);
    expect(m1).toMatchObject({ ok: true, layout: 'qodex', entry: path.join(a, 'register.js') });

    const b = path.join(ROOT, 'layout-b');
    write(path.join(b, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'beta', description: 'cc plugin', userConfig: { greeting: { type: 'string', default: 'hi' } } }));
    write(path.join(b, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.mjs'] }));
    write(path.join(b, 'hooks', 'register.mjs'), 'export function register(on) { on("turn.start", ($, e, next) => next(e)); }');
    const m2 = await L.readModManifest(b);
    expect(m2).toMatchObject({ ok: true, layout: 'claude', entry: path.join(b, 'hooks', 'register.mjs') });
    expect(m2.ok && m2.manifest.userConfig?.greeting?.default).toBe('hi');
  });

  it('reports bad manifests instead of throwing', async () => {
    const cases: Array<[string, () => void, RegExp]> = [
      ['no-manifest', () => write(path.join(ROOT, 'bad1', 'register.js'), ''), /no mod.json/],
      ['bad-json', () => write(path.join(ROOT, 'bad2', 'mod.json'), '{ nope'), /not valid JSON/],
      ['bad-name', () => write(path.join(ROOT, 'bad3', 'mod.json'), JSON.stringify({ name: 'has space' })), /needs a "name"/],
      ['no-entry', () => write(path.join(ROOT, 'bad4', 'mod.json'), JSON.stringify({ name: 'ok' })), /no entry file/],
      ['main-outside', () => { write(path.join(ROOT, 'bad5', 'mod.json'), JSON.stringify({ name: 'ok', main: '../x.js' })); }, /outside the mod dir/],
      ['no-modules', () => { write(path.join(ROOT, 'bad6', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ok' })); write(path.join(ROOT, 'bad6', 'hooks', 'hooks.json'), '{}'); }, /no "modules"/],
    ];
    for (let i = 0; i < cases.length; i++) {
      const [label, make, re] = cases[i]!;
      make();
      const r = await L.readModManifest(path.join(ROOT, `bad${i + 1}`));
      expect(r.ok, label).toBe(false);
      expect(!r.ok && r.error, label).toMatch(re);
    }
  });

  it('loads a TypeScript entry (types stripped, relative .ts import followed)', async () => {
    const dir = path.join(QHOME, 'mods', 'typed');
    write(path.join(dir, 'mod.json'), JSON.stringify({ name: 'typed' }));
    write(path.join(dir, 'helper.ts'), 'export function shout(s: string): string { return s.toUpperCase(); }\n');
    write(path.join(dir, 'register.ts'), `import { shout } from './helper.ts';
interface Opts { suffix?: string }
export function register(on: any, options: Opts): void {
  on('command.run', { command: 'typed-cmd' }, (): { text: string } => ({ text: shout('typed ok') }));
}
`);
    const rt = await R.initMods({ cwd: freshCwd(), surface: 'terminal', noBuiltins: true });
    expect(rt.list().find(i => i.name === 'typed')).toMatchObject({ loaded: true });
    const r = await rt.engine.emit('command.run', { command: 'typed-cmd', args: '' });
    expect(r.result).toEqual({ text: 'TYPED OK' });
  });

  it('a register() that throws leaves the mod unloaded with its error; others still load', async () => {
    write(path.join(QHOME, 'mods', 'boom', 'mod.json'), JSON.stringify({ name: 'boom' }));
    write(path.join(QHOME, 'mods', 'boom', 'register.js'), 'export function register() { throw new Error("kaput"); }');
    qodexMod(path.join(QHOME, 'mods', 'fine'), 'fine');
    const rt = await R.initMods({ cwd: freshCwd(), surface: 'terminal', noBuiltins: true });
    const infos = rt.list();
    expect(infos.find(i => i.name === 'boom')).toMatchObject({ loaded: false, error: 'kaput' });
    expect(infos.find(i => i.name === 'fine')).toMatchObject({ loaded: true });
  });
});

describe('state: enabled, trust, shadowing, options', () => {
  it('project mods load only after trust; a changed file needs a new trust', async () => {
    const c = freshCwd();
    const dir = path.join(c, '.qodex', 'mods', 'proj');
    qodexMod(dir, 'proj', 'project v1');
    let rt = await R.initMods({ cwd: c, surface: 'terminal', noBuiltins: true });
    expect(rt.list().find(i => i.name === 'proj')).toMatchObject({ loaded: false, trusted: false, trustState: 'untrusted', scope: 'project' });
    expect(await C.handleModsSlash([], c)).toMatch(/⚠ proj {2}\[project\] untrusted[\s\S]*\/mods trust proj/);

    expect(await C.trustMod('proj', c)).toMatch(/Trusted proj[\s\S]*Loaded\./);
    expect(rt.isLoaded('proj')).toBe(true);
    const state = await L.readModsState();
    expect(Object.values(state.trusted)[0]).toMatchObject({ name: 'proj' });

    // A change to any file of the mod: the next session refuses it until trusted again.
    R.resetModsRuntimeForTesting();
    write(path.join(dir, 'register.js'), fs.readFileSync(path.join(dir, 'register.js'), 'utf-8').replace('project v1', 'project v2'));
    rt = await R.initMods({ cwd: c, surface: 'terminal', noBuiltins: true });
    expect(rt.list().find(i => i.name === 'proj')).toMatchObject({ loaded: false, trustState: 'changed' });
    expect(await C.untrustMod('proj', c)).toMatch(/no longer trusted/);
  });

  it('trust covers what a symlink points at, node_modules, and every byte (no partial hash)', async () => {
    const c = freshCwd();
    const dir = path.join(c, '.qodex', 'mods', 'linky');
    write(path.join(dir, 'mod.json'), JSON.stringify({ name: 'linky' }));
    // The entry is a symlink to a repo file outside the mod dir.
    const outside = path.join(c, 'scripts', 'linky.js');
    write(outside, 'export function register(on) { on("turn.start", ($, e, next) => next(e)); }');
    fs.symlinkSync(outside, path.join(dir, 'register.js'));
    write(path.join(dir, 'node_modules', 'dep', 'index.js'), 'export const v = 1;');
    expect(await C.trustMod('linky', c)).toMatch(/Trusted linky/);
    const trusted = async () => (await L.discoverMods({ cwd: c, noBuiltins: true })).find(d => d.info.name === 'linky')!.info;
    expect(await trusted()).toMatchObject({ trusted: true, trustState: 'trusted' });

    write(outside, 'export function register(on) { /* changed behind the link */ }');
    expect(await trusted()).toMatchObject({ trusted: false, trustState: 'changed' });
    expect(await C.trustMod('linky', c)).toMatch(/Trusted linky/);
    write(path.join(dir, 'node_modules', 'dep', 'index.js'), 'export const v = 2;');
    expect(await trusted()).toMatchObject({ trusted: false, trustState: 'changed' });

    // Past the limits a project mod cannot be trusted at all (no "first N files" hash).
    L.setModHashLimitsForTesting({ files: 50, bytes: 4096 });
    try {
      write(path.join(dir, 'aaa-padding.bin'), 'x'.repeat(5000));
      expect(await C.trustMod('linky', c)).toMatch(/Cannot trust linky: .*too large to verify/);
      expect(await trusted()).toMatchObject({ trusted: false, error: expect.stringMatching(/too large to verify/) });
      fs.rmSync(path.join(dir, 'aaa-padding.bin'));
      for (let i = 0; i < 60; i++) write(path.join(dir, 'aaa', `f${i}.txt`), '');
      expect(await C.trustMod('linky', c)).toMatch(/Cannot trust linky: .*too large to verify/);
      // The non-strict change detector (hot reload) still answers past the limits.
      await expect(L.hashModDir(dir)).resolves.toMatch(/^[0-9a-f]{64}$/);
    } finally {
      L.setModHashLimitsForTesting(null);
    }
  });

  it('enable / disable persist in ~/.qodex/mods.json and apply in-session', async () => {
    qodexMod(path.join(QHOME, 'mods', 'toggly'), 'toggly');
    const rt = await R.initMods({ cwd: freshCwd(), surface: 'terminal', noBuiltins: true });
    expect(rt.isLoaded('toggly')).toBe(true);
    expect(await C.enableMod('toggly', cwd, false)).toMatch(/disabled and unloaded/);
    expect(rt.isLoaded('toggly')).toBe(false);
    expect((await L.readModsState()).disabled).toEqual(['toggly']);
    expect(await C.enableMod('toggly', cwd, true)).toMatch(/enabled and loaded/);
    expect(rt.isLoaded('toggly')).toBe(true);
    expect(await C.enableMod('nope', cwd, true)).toMatch(/No mod named/);
  });

  it('--mod-dir wins over a user mod of the same name; built-ins follow their manifest default', async () => {
    qodexMod(path.join(QHOME, 'mods', 'dup'), 'dup', 'user copy');
    const extra = path.join(ROOT, 'extra-dup');
    qodexMod(extra, 'dup', 'dev copy');
    const all = await L.discoverMods({ cwd: freshCwd(), extraDirs: [extra], noBuiltins: true });
    const dups = all.filter(d => d.info.name === 'dup');
    expect(dups[0]!.info).toMatchObject({ dir: extra, fromModDir: true });
    expect(dups[1]!.info.error).toMatch(/shadowed by the --mod-dir mod/);
    expect(L.manifestDefaultEnabled({ name: 'x', defaultEnabled: false })).toBe(false);
    expect(L.manifestDefaultEnabled({ name: 'x', enabledByDefault: false } as any)).toBe(false);
    expect(L.manifestDefaultEnabled({ name: 'x' })).toBe(true);
  });

  it('userConfig defaults, overridden (and coerced) by mods.json config', () => {
    const manifest = { name: 'm', userConfig: { n: { type: 'number' as const, default: 1 }, s: { type: 'string' as const, default: 'a' }, b: { type: 'boolean' as const } } };
    expect(L.resolveModOptions(manifest, undefined)).toEqual({ n: 1, s: 'a' });
    expect(L.resolveModOptions(manifest, { n: '7', b: 'true' })).toEqual({ n: 7, s: 'a', b: true });
  });

  it('the content hash changes with any file of the mod', async () => {
    const dir = path.join(ROOT, 'hashme');
    qodexMod(dir, 'hashme');
    const h1 = await L.hashModDir(dir);
    expect(await L.hashModDir(dir)).toBe(h1);
    write(path.join(dir, 'lib', 'util.js'), 'export const x = 1;');
    expect(await L.hashModDir(dir)).not.toBe(h1);
  });
});

describe('hot reload', () => {
  it('a saved change to a user mod reloads it (session.start fires again for it)', async () => {
    const dir = path.join(QHOME, 'mods', 'hot');
    qodexMod(dir, 'hot', 'before');
    const rt = await R.initMods({ cwd: freshCwd(), surface: 'terminal', noBuiltins: true, watch: true });
    await rt.startSession('s-hot', cwd);
    const run = async () => (await rt.engine.emit('command.run', { command: 'hot-cmd', args: '' })).result;
    expect(await run()).toEqual({ text: 'before' });
    expect(CR.getModCommand('hot-cmd')?.plugin).toBe('hot');

    write(path.join(dir, 'register.js'), fs.readFileSync(path.join(dir, 'register.js'), 'utf-8').replace("'before'", "'after'"));
    const deadline = Date.now() + 5_000;
    let got: unknown;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      got = await run();
      if ((got as { text?: string })?.text === 'after') break;
    }
    expect(got).toEqual({ text: 'after' });
    expect(CR.getModCommand('hot-cmd')?.plugin).toBe('hot'); // re-registered by the new session.start
  });

  it('reloadChangedUnder loads a new mod and unloads a removed one', async () => {
    const rt = await R.initMods({ cwd: freshCwd(), surface: 'terminal', noBuiltins: true });
    const root = path.join(QHOME, 'mods');
    qodexMod(path.join(root, 'late'), 'late');
    expect(await rt.reloadChangedUnder(root)).toEqual(['late']);
    fs.rmSync(path.join(root, 'late'), { recursive: true, force: true });
    await rt.reloadChangedUnder(root);
    expect(rt.isLoaded('late')).toBe(false);
  });
});
