import { describe, it, expect } from 'vitest';
import { focusLaunch, parseOperator } from '../src/desktop/operator.js';
import { handleShell, type ShellView } from '../src/desktop/shell.js';

const view = (): ShellView => ({
  token: 'tok', tree: '', result: '', shot: false, gui: 'x11', access: 'none', note: 'n',
  desks: 0, pending: 0, resident: 'off', controls: [], capped: false, waits: [], team: [], audit: [],
});

const deps = (operate: (cmd: unknown) => Promise<{ content: string }>) => ({
  readTree: async () => ({ ok: true as const, text: '' }),
  invoke: async () => ({ content: '' }),
  typeText: async () => ({ content: '' }),
  operate,
  shoot: async () => ({ ok: false as const, error: 'no' }),
  shotFile: () => null,
  setShot: () => {},
  decide: async () => ({ ok: true }),
  board: async () => ({ ok: true, message: 'queued' }),
  launch: async () => ({ ok: true, message: 'running' }),
});

describe('operator access', () => {
  it('accepts a click and refuses a modifier-only combo', () => {
    expect(parseOperator({ kind: 'click', x: '12', y: '40', button: 'right', count: '2' })).toEqual({
      ok: true, command: { kind: 'click', x: 12, y: 40, button: 'right', count: 2 },
    });
    expect(parseOperator({ kind: 'click', x: '-1', y: '2' }).ok).toBe(false);
    expect(parseOperator({ kind: 'key', combo: 'ctrl+shift' }).ok).toBe(false);
    expect(parseOperator({ kind: 'key', combo: 'ctrl+l' })).toEqual({ ok: true, command: { kind: 'key', combo: 'ctrl+l' } });
    expect(parseOperator({ kind: 'focus', app: 'Notes"\n' }).ok).toBe(false);
    const mac = focusLaunch('darwin', 'Notes');
    expect('cmd' in mac && mac.cmd).toBe('osascript');
    const linux = focusLaunch('linux', 'Notes');
    expect(linux).toEqual({ cmd: 'wmctrl', args: ['-a', 'Notes'] });
  });

  it('runs a human click and does not run a bad one', async () => {
    let seen = '';
    const ok = await handleShell({
      method: 'POST', pathname: '/act', tokenOk: true,
      rawBody: 'action=operate&kind=click&x=3&y=4',
      view: view(),
      deps: deps(async cmd => { seen = JSON.stringify(cmd); return { content: 'Clicked at (3, 4)' }; }),
    });
    expect(seen).toContain('"kind":"click"');
    expect(ok.view.result).toContain('Clicked');
    let called = false;
    const bad = await handleShell({
      method: 'POST', pathname: '/act', tokenOk: true,
      rawBody: 'action=operate&kind=click&x=no&y=1',
      view: view(),
      deps: deps(async () => { called = true; return { content: 'no' }; }),
    });
    expect(called).toBe(false);
    expect(bad.view.result).toContain('refused');
  });
});
