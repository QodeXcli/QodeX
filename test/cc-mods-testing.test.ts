/**
 * The mods test kit (createTestHarness, mock.clock, mount/press), the `qodex mod test`
 * runner on real test files (.mjs and .ts), `qodex mod validate`, the scaffold, and the
 * instruction-file guard for mod dirs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ModRegisterFn } from '../src/mods/types.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-mods-kit-'));
const QHOME = path.join(ROOT, '.qodex');

let T: typeof import('../src/mods/testing.js');
let C: typeof import('../src/mods/command.js');
let IF: typeof import('../src/security/instruction-files.js');

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeAll(async () => {
  (await import('../src/mods/paths.js')).setModsHomeForTesting(QHOME);
  T = await import('../src/mods/testing.js');
  C = await import('../src/mods/command.js');
  IF = await import('../src/security/instruction-files.js');
});

afterAll(async () => {
  (await import('../src/mods/paths.js')).setModsHomeForTesting(null);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const tally: ModRegisterFn = (on) => {
  let n = 0;
  on('session.start', async ($, e, next) => { await $.command.register({ name: 'tally', description: 'Count tool calls' }); return next(e); });
  on('tool.call', async ($, e, next) => { n++; return next(e); });
  on('command.run', { command: 'tally' }, () => ({ text: `${n} tool call${n === 1 ? '' : 's'}` }));
};

describe('createTestHarness', () => {
  it('fires events through the hooks with stubs standing in for QodeX', async () => {
    const h = T.createTestHarness({ register: tally, name: 'tally-mod' });
    h.on('tool.call', () => ({ result: 'ok' }));
    await h.$.session.start();
    expect([...h.commands.keys()]).toEqual(['tally']);
    expect(await h.$.tool.call({ tool: 'shell', command: 'ls' })).toEqual({ result: 'ok' });
    await h.$.tool.call({ tool: 'read_file', args: { path: 'a' } });
    expect(await h.$.command.run({ command: 'tally' })).toEqual({ text: '2 tool calls' });
    expect(() => h.on('x', () => undefined)).toThrow(/after the test first called \$/);
  });

  it('a tool.call that reaches QodeX without a stub fails clearly; $ calls need stubs', async () => {
    const h = T.createTestHarness({
      register: (on) => {
        on('tool.call', ($, e, next) => next(e));
        on('command.run', async ($) => ({ text: (await $.model.complete({ prompt: 'grade' })).isAnswered ? 'answered' : 'not' }));
      },
    });
    await expect(h.$.tool.call({ tool: 'shell', command: 'ls' })).rejects.toThrow(/no implementation for tool.call/);
    expect(await h.$.command.run({ command: 'g' })).toBeUndefined(); // the hook was skipped: no stub for model.complete
    expect(h.ui.errors.join('\n')).toMatch(/no implementation for model.complete/);
  });

  it('mock.clock drives timers without waiting', async () => {
    const h = T.createTestHarness({
      register: (on) => {
        on('command.run', { command: 'countdown' }, async ($, e) => {
          let left = Number(e.args);
          const t = $.clock.every(1000, () => { left -= 1; if (left === 0) { t.cancel(); $.ui.toast('Time is up'); } });
          return {};
        });
      },
    });
    const clock = T.mock.clock((n, s) => h.on(n, s));
    await h.$.command.run({ command: 'countdown', args: '3' });
    await clock.advance(2000);
    expect(h.ui.toasts).toEqual([]);
    await clock.advance(1000);
    expect(h.ui.toasts).toEqual(['Time is up']);
  });

  it('mounts a render site, presses a Button, and the store keeps the count', async () => {
    const h = T.createTestHarness({
      register: (on) => {
        on('ui.render', { component: 'Pane' }, async ($, e) => {
          const { Box, Text, Button } = $.ui.resolve(e);
          const count = (await $.store.get('count') as number | undefined) ?? 0;
          return Box({ children: [Text({ children: [`Count: ${count}`] }), Button({ key: 'more', label: '+', onPress: async () => { await $.store.set('count', count + 1); } })] });
        });
      },
    });
    const saved = new Map<string, unknown>();
    h.on('store.get', (_$, e) => ({ value: saved.get(e.key) }));
    h.on('store.set', (_$, e) => { saved.set(e.key, e.value); return { value: undefined }; });
    const ui = await h.$.ui.mount({ component: 'Pane', requestId: 'p' });
    expect(ui.find({ type: 'Text', text: 'Count: 0' })).toBeDefined();
    await ui.press({ key: 'more' });
    await ui.press({ key: 'more' });
    expect(ui.find({ type: 'Text', text: /^Count: \d+$/ })).toMatchObject({ children: ['Count: 2'] });
    expect(saved.get('count')).toBe(2);
    await expect(ui.press({ key: 'nope' })).rejects.toThrow(/no Button with key "nope"/);
  });

  it('expect() covers the matchers a mod test uses', () => {
    T.expect({ a: 1, b: [1, 2] }).toEqual({ a: 1, b: [1, 2] });
    T.expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
    T.expect('hello').toMatch(/ell/);
    T.expect([1, { x: 2 }]).toContain({ x: 2 });
    T.expect(undefined).toBeUndefined();
    T.expect(() => { throw new Error('boom'); }).toThrow('boom');
    T.expect(1).not.toBe(2);
    expect(() => T.expect(1).toBe(2)).toThrow(/expected 1 to be 2/);
  });
});

describe('qodex mod test / validate / new', () => {
  it('runs .test.mjs and .test.ts files against a mod on disk (Claude Code layout) and reports failures', async () => {
    const dir = path.join(ROOT, 'first-mod');
    write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'first-mod' }));
    write(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.js'] }));
    write(path.join(dir, 'hooks', 'register.js'), `
let count = 0;
export function register(on) {
  on('tool.call', async ($, e, next) => { count += 1; return next(e); });
  on('command.run', { command: 'tally' }, () => ({ text: 'Claude has made ' + count + ' tool calls since this mod loaded' }));
}
`);
    write(path.join(dir, 'tests', 'first-mod.test.ts'), `import { expect, test } from 'claude-code/testing';
test('/tally reports the tool calls the mod has seen', async ($: any, on: any) => {
  on('tool.call', () => ({ result: 'ok' }));
  await $.tool.call({ tool: 'Bash', command: 'ls' });
  await $.tool.call({ tool: 'Read', file_path: 'README.md' });
  const answer = await $.command.run({ command: 'tally', args: '' });
  expect(answer.text).toBe('Claude has made 2 tool calls since this mod loaded');
});
`);
    write(path.join(dir, 'tests', 'fresh.test.mjs'), `import { expect, test } from 'qodex/testing';
test('each test loads the mod fresh', async ($, on) => {
  const answer = await $.command.run({ command: 'tally', args: '' });
  expect(answer.text).toBe('Claude has made 0 tool calls since this mod loaded');
});
test('a failing check is reported', async ($) => {
  expect(1).toBe(2);
});
`);
    const out: string[] = [];
    const r = await T.runModTests(dir, { out: l => out.push(l) });
    expect(r.results.map(x => [x.name, x.ok])).toEqual([
      ['/tally reports the tool calls the mod has seen', true],
      ['each test loads the mod fresh', true],
      ['a failing check is reported', false],
    ]);
    expect(out.join('\n')).toMatch(/\(pass\) \/tally reports[\s\S]*\(fail\) a failing check is reported[\s\S]*expected 1 to be 2[\s\S]* 2 pass\n 1 fail/);
  });

  it('a test file with no test() fails', async () => {
    const dir = path.join(ROOT, 'empty-tests');
    write(path.join(dir, 'mod.json'), JSON.stringify({ name: 'empty-tests' }));
    write(path.join(dir, 'register.js'), 'export function register() {}');
    write(path.join(dir, 'nothing.test.mjs'), 'export const x = 1;');
    const r = await T.runModTests(dir, { out: () => undefined });
    expect(r.results[0]).toMatchObject({ ok: false, error: 'declares no test(): nothing ran' });
  });

  it('scaffold → validate → test round trip', async () => {
    const made = await C.scaffoldMod('standup', { root: path.join(ROOT, 'mods') });
    expect(made.ok).toBe(true);
    expect((await C.scaffoldMod('standup', { root: path.join(ROOT, 'mods') })).ok).toBe(false);
    const v = await C.validateModDir(made.dir);
    expect(v).toMatchObject({ ok: true, name: 'standup', layout: 'qodex', commands: ['/standup'] });
    expect(v.events).toEqual(['session.start', 'tool.call', 'command.run']);
    expect(v.apiCalls).toEqual(['command.register', 'ui.status']);
    const r = await T.runModTests(made.dir, { out: () => undefined });
    expect(r).toMatchObject({ passed: 1, failed: 0 });
  });

  it('validate reports a refused command name and a broken manifest', async () => {
    const dir = path.join(ROOT, 'clash');
    write(path.join(dir, 'mod.json'), JSON.stringify({ name: 'clash' }));
    write(path.join(dir, 'register.js'), `export function register(on) {
  on('session.start', async ($, e, next) => { await $.command.register({ name: 'help', description: 'x' }); return next(e); });
  on('classic.Stop', ($, e, next) => next(e));
}`);
    const v = await C.validateModDir(dir);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/"\/help" refused: it is the built-in \/help/);
    expect(v.warnings.join('\n')).toMatch(/classic.Stop.*never fires/);
    expect(C.formatValidation(v)).toMatch(/^✗ clash/);
    const broken = await C.validateModDir(path.join(ROOT, 'does-not-exist'));
    expect(broken).toMatchObject({ ok: false });
    expect(broken.errors[0]).toMatch(/no mod.json/);
  });
});

describe('security', () => {
  it('~/.qodex/mods/** and ~/.qodex/mods.json are agent instruction files; mods-store is not', () => {
    const home = '/home/u';
    expect(IF.instructionFileHit('~/.qodex/mods/x/register.js', '/work', home)).toEqual({ label: '~/.qodex/mods/x/register.js', scope: 'user' });
    expect(IF.instructionFileHit('/home/u/.qodex/mods.json', '/work', home)).toEqual({ label: '~/.qodex/mods.json', scope: 'user' });
    expect(IF.instructionFileHit('.qodex/mods/x/register.js', '/work', home)).toMatchObject({ scope: 'project' });
    expect(IF.instructionFileHit('/home/u/.qodex/mods-store/x.json', '/work', home)).toBeNull();
  });
});
