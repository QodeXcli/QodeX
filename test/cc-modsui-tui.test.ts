/**
 * The mods UI mounted in the real TUI (src/cli/ui.tsx): the band directly above the prompt,
 * a pane above it, status lines under it, toasts and notice lines, and the keyboard —
 * Ctrl+X Tab gives a pane the keyboard, its hotkeys press its Buttons, other keys stay out
 * of the prompt, Esc gives the keyboard back. Rendered through Ink with a fake stdin/stdout
 * and a fake mods host standing in for the runtime.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ModsUiHost, ModUiEvent } from '../src/mods/ui/host.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-modsui-tui-home-'));
const ORIG_HOME = process.env.HOME;
const ORIG_MOTION = process.env.QODEX_NO_MOTION;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

let S: typeof import('../src/session/store.js');
let setModsUiHost: typeof import('../src/mods/ui/host.js').setModsUiHost;

beforeAll(async () => {
  process.env.HOME = HOME;
  process.env.QODEX_NO_MOTION = '1';
  S = await import('../src/session/store.js');
  S.setSessionStoreForTests(new S.SessionStore(path.join(HOME, 'sessions-modsui.db')));
  setModsUiHost = (await import('../src/mods/ui/host.js')).setModsUiHost;
});

afterAll(() => {
  setModsUiHost?.(null);
  S?.setSessionStoreForTests(null);
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  if (ORIG_MOTION === undefined) delete process.env.QODEX_NO_MOTION; else process.env.QODEX_NO_MOTION = ORIG_MOTION;
  fs.rmSync(HOME, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll until `check` holds (the suite may run on a busy machine), then return. */
async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(25);
  }
}

async function mountApp() {
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { App } = await import('../src/cli/ui.js');
  const { DEFAULT_CONFIG } = await import('../src/config/defaults.js');
  const { ModelRouter } = await import('../src/llm/router.js');
  const { ToolRegistry } = await import('../src/tools/registry.js');
  const { PermissionEngine } = await import('../src/security/permissions.js');

  const stdout = new EventEmitter() as any;
  let last = '';
  Object.assign(stdout, { columns: 100, rows: 40, isTTY: false, write: (s: string) => { if (s.trim()) last = s; return true; } });
  const stdin = new EventEmitter() as any;
  const queue: string[] = [];
  Object.assign(stdin, {
    isTTY: true, setRawMode() {}, setEncoding() {}, resume() {}, pause() {}, ref() {}, unref() {},
    read: () => queue.shift() ?? null,
  });
  const config = { ...DEFAULT_CONFIG };
  const registry = new ToolRegistry();
  const inst = render(React.createElement(App, {
    cwd: HOME, config, router: new ModelRouter(config), registry,
    permissions: new PermissionEngine(config, (n: string) => registry.get(n)),
  }), { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
  return {
    frame: () => last.replace(ANSI, ''),
    press: async (s: string, ms = 60) => { queue.push(s); stdin.emit('readable'); await wait(ms); },
    unmount: () => inst.unmount(),
  };
}

function fakeHost() {
  let emit: (ev: ModUiEvent) => void = () => {};
  let count = 0;
  const presses: string[] = [];
  const host: ModsUiHost = {
    subscribe(l) { emit = l; return () => { emit = () => {}; }; },
    async renderSite(req) {
      if (req.component === 'AbovePrompt') {
        return { trees: [{ plugin: 'ctx', tree: { type: 'Text', props: { color: 'cyan' }, children: ['BAND-LINE'] } }] };
      }
      if (req.component === 'Pane' && req.requestId === 'hello') {
        return { trees: [{ plugin: 'hello', tree: { type: 'Box', props: { flexDirection: 'row', columnGap: 2 }, children: [
          { type: 'Button', props: { key: 'more', label: 'Add one', hotkey: 'a', onPress: () => { count++; } }, children: [] },
          { type: 'Text', props: {}, children: [`Count: ${count}`] },
        ] } }] };
      }
      return { trees: [] };
    },
    async press(req, onPress) { presses.push(req.key); await onPress?.(); },
    list: () => [],
  };
  return { host, emit: (ev: ModUiEvent) => emit(ev), presses, count: () => count };
}

describe('mods UI in the TUI', () => {
  it('draws nothing extra without a host; band, pane, status, toast and notice with one; keyboard focus', async () => {
    setModsUiHost(null);
    const app = await mountApp();
    try {
      await until(() => app.frame().includes('Type a task'), 'the prompt');
      await wait(150);
      const plain = app.frame();
      expect(plain).toContain('Type a task');
      expect(plain).not.toMatch(/BAND-LINE|⚠|◆/);

      const f = fakeHost();
      setModsUiHost(f.host);
      await until(() => app.frame().includes('BAND-LINE'), 'the band');
      f.emit({ kind: 'status', plugin: 'ctx', text: '82% of the window' });
      f.emit({ kind: 'toast', plugin: 'hello', text: 'saved' });
      f.emit({ kind: 'notice', plugin: 'ysk', text: 'the test you skipped still fails' });
      f.emit({ kind: 'open', plugin: 'hello', id: 'hello', title: 'Hello tabs' });
      await until(() => app.frame().includes('Count: 0') && app.frame().includes('◆ hello: saved'), 'the pane');
      const lines = app.frame().split('\n');
      const at = (re: RegExp) => lines.findIndex(l => re.test(l));
      const prompt = at(/❯ Type a task/);
      expect(at(/Hello tabs/)).toBeGreaterThan(-1);
      expect(at(/Hello tabs/)).toBeLessThan(at(/BAND-LINE/));
      expect(at(/BAND-LINE/)).toBeLessThan(prompt);
      expect(at(/⚠ ctx: 82% of the window/)).toBeGreaterThan(prompt);
      expect(at(/◆ hello: saved/)).toBeGreaterThan(-1);
      expect(at(/💡 ysk: the test you skipped still fails/)).toBeGreaterThan(-1);
      expect(app.frame()).toContain('^X Tab focus');

      // Ctrl+X Tab: the pane takes the keyboard.
      await app.press('\u0018');
      await app.press('\t');
      await until(() => app.frame().includes('Esc back'), 'pane focus');
      await app.press('a');
      await until(() => app.frame().includes('Count: 1'), 'the first press');
      await app.press('a');
      await until(() => app.frame().includes('Count: 2'), 'the second press');
      await app.press('h', 150); // not a hotkey: swallowed, never typed into the prompt
      expect(f.presses).toEqual(['more', 'more']);
      expect(f.count()).toBe(2);
      expect(app.frame()).toContain('Count: 2');
      expect(app.frame()).toContain('❯ Type a task');

      // Esc gives the keyboard back; typing reaches the prompt again.
      await app.press('\u001b');
      await until(() => app.frame().includes('^X Tab focus'), 'focus back on the prompt');
      await app.press('h');
      await app.press('i');
      await until(() => /❯ hi\s/.test(app.frame()), 'typing in the prompt');
    } finally {
      app.unmount();
      setModsUiHost(null);
    }
  }, 20_000);
});
