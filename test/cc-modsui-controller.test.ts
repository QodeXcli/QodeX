/**
 * Mods UI controller (src/mods/ui/controller.ts): the TUI's side of the mods UI bus —
 * redraw throttling, tree validation + one-time refusal logs, status/toast/log/notice,
 * panes, the spinner suffix, and keyboard focus (Ctrl+X Tab, hotkeys, Enter, Esc).
 * Driven through a fake host that stands in for the mods runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModsUiController, type ModHistoryLine } from '../src/mods/ui/controller.js';
import { setModsUiHost, getModsUiHost, type ModRenderOutput, type ModRenderRequest, type ModsUiHost, type ModUiEvent } from '../src/mods/ui/host.js';
import type { ModElement } from '../src/mods/types.js';

type SiteAnswer = ModRenderOutput | ((req: ModRenderRequest) => ModRenderOutput);

function fakeHost() {
  const listeners = new Set<(ev: ModUiEvent) => void>();
  const renders: ModRenderRequest[] = [];
  const sites: Record<string, SiteAnswer> = {};
  const presses: Array<{ plugin: string; key: string; requestId?: string; component: string }> = [];
  const paneClosed = vi.fn();
  const host: ModsUiHost = {
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    async renderSite(req) {
      renders.push(req);
      const a = sites[req.component === 'Pane' ? `Pane:${req.requestId}` : req.component];
      return typeof a === 'function' ? a(req) : (a ?? { trees: [] });
    },
    async press(req, onPress) { presses.push(req); await onPress?.(); },
    list: () => [],
    paneClosed,
  };
  return { host, emit: (ev: ModUiEvent) => { for (const l of listeners) l(ev); }, renders, sites, presses, paneClosed, listeners };
}

const Text = (s: string, props: Record<string, unknown> = {}): ModElement => ({ type: 'Text', props, children: [s] } as ModElement);
const Box = (children: ModElement[]): ModElement => ({ type: 'Box', props: { flexDirection: 'row' }, children } as ModElement);
const Button = (key: string, extra: Record<string, unknown> = {}): ModElement =>
  ({ type: 'Button', props: { key, label: key.toUpperCase(), ...extra }, children: [] } as unknown as ModElement);

const k = (over: Record<string, boolean> = {}) => over;

let history: ModHistoryLine[];
let ctl: ModsUiController;

beforeEach(() => {
  vi.useFakeTimers();
  history = [];
  ctl = new ModsUiController({ onHistory: l => history.push(l) });
});

afterEach(() => {
  ctl.dispose();
  setModsUiHost(null);
  vi.useRealTimers();
});

const flush = async (ms = 150) => { await vi.advanceTimersByTimeAsync(ms); };

describe('rendering', () => {
  it('runs the band chain once attached and stacks valid trees', async () => {
    const f = fakeHost();
    f.sites.AbovePrompt = { trees: [{ plugin: 'a', tree: Text('first') }, { plugin: 'b', tree: Text('second') }] };
    ctl.attach(f.host);
    await flush();
    expect(f.renders[0]).toMatchObject({ component: 'AbovePrompt', surface: 'terminal', props: { isWorking: false } });
    expect(ctl.getSnapshot().band.map(b => b.plugin)).toEqual(['a', 'b']);
  });

  it('refuses an invalid tree, draws nothing for that mod, and logs the refusal once', async () => {
    const f = fakeHost();
    f.sites.AbovePrompt = { trees: [{ plugin: 'bad', tree: Text('x', { bogusProp: true }) }, { plugin: 'good', tree: Text('ok') }] };
    ctl.attach(f.host);
    await flush();
    for (let i = 0; i < 5; i++) { ctl.invalidate(); await flush(); }
    expect(ctl.getSnapshot().band.map(b => b.plugin)).toEqual(['good']);
    expect(history).toEqual([{ kind: 'log', plugin: 'bad', text: 'ui.render (AbovePrompt) refused: Text prop "bogusProp" is not allowed' }]);
  });

  it('throttles redraws to 10 a second and never runs two passes at once', async () => {
    const f = fakeHost();
    ctl.attach(f.host);
    await flush();
    const before = f.renders.length;
    for (let i = 0; i < 100; i++) { ctl.invalidate(); await vi.advanceTimersByTimeAsync(10); }
    const passes = f.renders.length - before;
    expect(passes).toBeGreaterThanOrEqual(8);
    expect(passes).toBeLessThanOrEqual(11);
  });

  it('a host that rejects or returns junk draws nothing and does not throw', async () => {
    const f = fakeHost();
    f.host.renderSite = async () => { throw new Error('boom'); };
    ctl.attach(f.host);
    await flush();
    expect(ctl.getSnapshot().band).toEqual([]);
    f.host.renderSite = async () => (undefined as unknown as ModRenderOutput);
    ctl.invalidate();
    await flush();
    expect(ctl.getSnapshot().band).toEqual([]);
  });

  it('spinner: suffix from the engine props while busy, nothing when idle', async () => {
    const f = fakeHost();
    f.sites.Spinner = { trees: [{ plugin: 'engine', tree: { type: 'engine', ref: 'Spinner' } }], engineProps: { suffix: ' · tool calls: 3…' } };
    ctl.attach(f.host);
    ctl.setContext({ busy: true });
    await flush();
    expect(f.renders.some(r => r.component === 'Spinner' && r.props.word === 'crafting')).toBe(true);
    expect(ctl.getSnapshot().spinner).toEqual({ suffix: ' · tool calls: 3…' });
    ctl.setContext({ busy: false });
    await flush();
    expect(ctl.getSnapshot().spinner).toBeNull();
  });

  it('follows the registered host (setModsUiHost) through start()', async () => {
    const f = fakeHost();
    f.sites.AbovePrompt = { trees: [{ plugin: 'a', tree: Text('hi') }] };
    const stop = ctl.start();
    expect(getModsUiHost()).toBeNull();
    setModsUiHost(f.host);
    await flush();
    expect(ctl.getSnapshot().band).toHaveLength(1);
    setModsUiHost(null);
    await flush();
    expect(ctl.getSnapshot().band).toEqual([]);
    stop();
    expect(f.listeners.size).toBe(0);
  });
});

describe('bus: status, toast, log, notice, panes, unload', () => {
  it('status lines per mod; null clears; newlines folded', async () => {
    const f = fakeHost();
    ctl.attach(f.host);
    f.emit({ kind: 'status', plugin: 'ctx', text: 'line one\nline two' });
    f.emit({ kind: 'status', plugin: 'other', text: 'x' });
    expect(ctl.getSnapshot().statuses).toEqual([{ plugin: 'ctx', text: 'line one line two' }, { plugin: 'other', text: 'x' }]);
    f.emit({ kind: 'status', plugin: 'ctx', text: null });
    expect(ctl.getSnapshot().statuses).toEqual([{ plugin: 'other', text: 'x' }]);
  });

  it('toasts last 4 seconds by default (or the asked time) and keep the newest three', async () => {
    const f = fakeHost();
    ctl.attach(f.host);
    f.emit({ kind: 'toast', plugin: 'm', text: 'hello' });
    f.emit({ kind: 'toast', plugin: 'm', text: 'quick', timeoutMs: 1000 });
    expect(ctl.getSnapshot().toasts.map(t => t.text)).toEqual(['hello', 'quick']);
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctl.getSnapshot().toasts.map(t => t.text)).toEqual(['hello']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ctl.getSnapshot().toasts).toEqual([]);
    for (const t of ['1', '2', '3', '4']) f.emit({ kind: 'toast', plugin: 'm', text: t });
    expect(ctl.getSnapshot().toasts.map(t => t.text)).toEqual(['2', '3', '4']);
  });

  it('log and notice go to the transcript only', async () => {
    const f = fakeHost();
    ctl.attach(f.host);
    f.emit({ kind: 'log', plugin: 'm', text: 'did a thing' });
    f.emit({ kind: 'notice', plugin: 'ysk', text: 'the test you skipped still fails' });
    f.emit({ kind: 'log', plugin: 'm', text: '   ' });
    expect(history).toEqual([
      { kind: 'log', plugin: 'm', text: 'did a thing' },
      { kind: 'notice', plugin: 'ysk', text: 'the test you skipped still fails' },
    ]);
  });

  it('opens and closes panes, renders each with its id, and unload drops a mod\'s UI', async () => {
    const f = fakeHost();
    f.sites['Pane:hello'] = { trees: [{ plugin: 'hello', tree: Text('pane body') }] };
    ctl.attach(f.host);
    f.emit({ kind: 'open', plugin: 'hello', id: 'hello', title: 'Hello tabs' });
    f.emit({ kind: 'status', plugin: 'hello', text: 'busy' });
    await flush();
    expect(f.renders.some(r => r.component === 'Pane' && r.requestId === 'hello' && r.props.placement === 'inline')).toBe(true);
    expect(ctl.getSnapshot().panes).toMatchObject([{ id: 'hello', title: 'Hello tabs', tree: { type: 'Text' } }]);
    expect(ctl.getSnapshot().activePane).toBe('hello');
    f.emit({ kind: 'unload', plugin: 'hello' });
    expect(ctl.getSnapshot().panes).toEqual([]);
    expect(ctl.getSnapshot().statuses).toEqual([]);
    f.emit({ kind: 'open', plugin: 'hello', id: 'bad id!' });
    expect(ctl.getSnapshot().panes).toEqual([]);
  });
});

describe('keyboard focus', () => {
  async function twoPanes() {
    const f = fakeHost();
    const pressed: string[] = [];
    const onPress = (name: string) => () => { pressed.push(name); };
    f.sites['Pane:p1'] = { trees: [{ plugin: 'm1', tree: Box([Button('a', { onPress: onPress('a') }), Button('b', { hotkey: '2', onPress: onPress('b') })]) }] };
    f.sites['Pane:p2'] = { trees: [{ plugin: 'm2', tree: Box([Button('c', { onPress: onPress('c') })]) }] };
    ctl.attach(f.host);
    f.emit({ kind: 'open', plugin: 'm1', id: 'p1', title: 'One' });
    f.emit({ kind: 'open', plugin: 'm2', id: 'p2', title: 'Two', closeOnEscape: true });
    await flush();
    return { f, pressed };
  }

  it('Ctrl+X Tab cycles prompt → panes → prompt; Ctrl+X itself is never swallowed', async () => {
    await twoPanes();
    expect(ctl.handleInput('x', k({ ctrl: true }))).toBe(false);
    expect(ctl.handleInput('', k({ tab: true }))).toBe(true);
    expect(ctl.getSnapshot().focus).toEqual({ kind: 'pane', id: 'p1' });
    expect(ctl.getSnapshot().activePane).toBe('p1');
    expect(ctl.getSnapshot().focusedKey).toBe('a');
    ctl.handleInput('x', k({ ctrl: true }));
    ctl.handleInput('', k({ tab: true }));
    expect(ctl.getSnapshot().focus).toEqual({ kind: 'pane', id: 'p2' });
    ctl.handleInput('x', k({ ctrl: true }));
    ctl.handleInput('', k({ tab: true }));
    expect(ctl.getSnapshot().focus).toBeNull();
  });

  it('a lone Tab without the chord is not taken when nothing is focused', async () => {
    await twoPanes();
    expect(ctl.handleInput('', k({ tab: true }))).toBe(false);
    expect(ctl.handleInput('a', k())).toBe(false);
    // The chord expires after 1.5s.
    ctl.handleInput('x', k({ ctrl: true }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctl.handleInput('', k({ tab: true }))).toBe(false);
  });

  it('Tab/arrows move between buttons, Enter and hotkeys press them through the host', async () => {
    const { f, pressed } = await twoPanes();
    ctl.handleInput('x', k({ ctrl: true }));
    ctl.handleInput('', k({ tab: true }));
    expect(ctl.handleInput('', k({ tab: true }))).toBe(true);
    expect(ctl.getSnapshot().focusedKey).toBe('b');
    ctl.handleInput('', k({ downArrow: true }));
    expect(ctl.getSnapshot().focusedKey).toBe('a');
    ctl.handleInput('', k({ upArrow: true }));
    expect(ctl.getSnapshot().focusedKey).toBe('b');
    expect(ctl.handleInput('\r', k({ return: true }))).toBe(true);
    await flush();
    expect(ctl.handleInput('2', k())).toBe(true);
    await flush();
    expect(pressed).toEqual(['b', 'b']);
    expect(f.presses[0]).toEqual({ plugin: 'm1', key: 'b', requestId: 'p1', component: 'Pane' });
    // Other printable keys are swallowed while a pane has the keyboard.
    expect(ctl.handleInput('q', k())).toBe(true);
    expect(pressed).toHaveLength(2);
  });

  it('Esc returns focus (and closes a closeOnEscape pane); Ctrl+C and Shift+Tab pass through', async () => {
    const { f } = await twoPanes();
    ctl.handleInput('x', k({ ctrl: true }));
    ctl.handleInput('', k({ tab: true }));
    expect(ctl.handleInput('c', k({ ctrl: true }))).toBe(false);
    expect(ctl.handleInput('', k({ tab: true, shift: true }))).toBe(false);
    expect(ctl.handleInput('', k({ escape: true }))).toBe(true);
    expect(ctl.getSnapshot().focus).toBeNull();
    expect(ctl.getSnapshot().panes).toHaveLength(2);
    // p2 closes on Esc.
    ctl.handleInput('x', k({ ctrl: true })); ctl.handleInput('', k({ tab: true }));
    ctl.handleInput('x', k({ ctrl: true })); ctl.handleInput('', k({ tab: true }));
    expect(ctl.getSnapshot().focus).toEqual({ kind: 'pane', id: 'p2' });
    ctl.handleInput('', k({ escape: true }));
    expect(ctl.getSnapshot().panes.map(p => p.id)).toEqual(['p1']);
    expect(f.paneClosed).toHaveBeenCalledWith({ plugin: 'm2', id: 'p2' });
  });

  it('Ctrl+X X closes the focused pane', async () => {
    const { f } = await twoPanes();
    ctl.handleInput('x', k({ ctrl: true }));
    ctl.handleInput('', k({ tab: true }));
    ctl.handleInput('x', k({ ctrl: true }));
    expect(ctl.handleInput('x', k())).toBe(true);
    expect(ctl.getSnapshot().panes.map(p => p.id)).toEqual(['p2']);
    expect(ctl.getSnapshot().focus).toBeNull();
    expect(f.paneClosed).toHaveBeenCalledWith({ plugin: 'm1', id: 'p1' });
  });

  it('a mod closing the focused pane gives the keyboard back', async () => {
    const { f } = await twoPanes();
    ctl.handleInput('x', k({ ctrl: true }));
    ctl.handleInput('', k({ tab: true }));
    f.emit({ kind: 'close', plugin: 'm1', id: 'p1' });
    expect(ctl.getSnapshot().focus).toBeNull();
    expect(f.paneClosed).not.toHaveBeenCalled();
  });

  it('open({ focus: true }) takes the keyboard only while the prompt is empty', async () => {
    const f = fakeHost();
    f.sites['Pane:p'] = { trees: [{ plugin: 'm', tree: Box([Button('z', { autoFocus: true })]) }] };
    ctl.attach(f.host);
    ctl.setContext({ promptEmpty: false });
    f.emit({ kind: 'open', plugin: 'm', id: 'p', focus: true });
    expect(ctl.getSnapshot().focus).toBeNull();
    ctl.setContext({ promptEmpty: true });
    f.emit({ kind: 'open', plugin: 'm', id: 'p', focus: true });
    await flush();
    expect(ctl.getSnapshot().focus).toEqual({ kind: 'pane', id: 'p' });
    expect(ctl.getSnapshot().focusedKey).toBe('z');
  });

  it('the band is a focus target when it has buttons; a button that throws is logged', async () => {
    const f = fakeHost();
    f.host.press = async (_req, onPress) => { await onPress?.(); };
    f.sites.AbovePrompt = { trees: [{ plugin: 'bandmod', tree: Box([Button('go', { hotkey: 'g', onPress: () => { throw new Error('nope'); } })]) }] };
    ctl.attach(f.host);
    await flush();
    ctl.handleInput('x', k({ ctrl: true }));
    ctl.handleInput('', k({ tab: true }));
    expect(ctl.getSnapshot().focus).toEqual({ kind: 'band' });
    ctl.handleInput('g', k());
    await flush();
    expect(history.at(-1)).toEqual({ kind: 'log', plugin: 'bandmod', text: 'button "go" failed: nope' });
  });

  it('band buttons of two mods that share a key are both reachable, and Enter presses the focused one', async () => {
    const f = fakeHost();
    const pressed: string[] = [];
    f.sites.AbovePrompt = { trees: [
      { plugin: 'one', tree: Box([Button('refresh', { onPress: () => { pressed.push('one'); } })]) },
      { plugin: 'two', tree: Box([Button('refresh', { onPress: () => { pressed.push('two'); } })]) },
    ] };
    ctl.attach(f.host);
    await flush();
    ctl.handleInput('x', k({ ctrl: true }));
    ctl.handleInput('', k({ tab: true }));
    expect(ctl.getSnapshot()).toMatchObject({ focus: { kind: 'band' }, focusedKey: 'refresh', focusedPlugin: 'one' });
    ctl.handleInput('', k({ tab: true }));
    expect(ctl.getSnapshot()).toMatchObject({ focusedKey: 'refresh', focusedPlugin: 'two' });
    ctl.handleInput('\r', k({ return: true }));
    await flush();
    expect(pressed).toEqual(['two']);
    expect(f.presses).toEqual([{ plugin: 'two', key: 'refresh', component: 'AbovePrompt' }]);
    ctl.handleInput('', k({ downArrow: true }));
    expect(ctl.getSnapshot().focusedPlugin).toBe('one');
  });

  it('without a host nothing is focusable and keys pass through', () => {
    expect(ctl.handleInput('x', k({ ctrl: true }))).toBe(false);
    expect(ctl.handleInput('', k({ tab: true }))).toBe(true); // the chord toasts "nothing to focus"
    expect(ctl.getSnapshot().toasts.at(-1)?.text).toMatch(/Nothing to focus/);
    expect(ctl.handleInput('a', k())).toBe(false);
  });
});

describe('chord, sanitizing and repaint economy', () => {
  it('Ctrl+X marks a chord (the TUI keeps the next key out of the prompt) until a key or 1.5s', async () => {
    const f = fakeHost();
    ctl.attach(f.host);
    ctl.handleInput('x', k({ ctrl: true }));
    expect(ctl.getSnapshot().chord).toBe(true);
    ctl.handleInput('q', k());
    expect(ctl.getSnapshot().chord).toBe(false);
    ctl.handleInput('x', k({ ctrl: true }));
    expect(ctl.getSnapshot().chord).toBe(true);
    await vi.advanceTimersByTimeAsync(1600);
    expect(ctl.getSnapshot().chord).toBe(false);
  });

  it('strips terminal control characters from status, toast, log lines and trees', async () => {
    const f = fakeHost();
    f.sites.AbovePrompt = { trees: [{ plugin: 'a', tree: Text('hi\u001b[2Jthere\u0007', { color: 'red' }) }] };
    ctl.attach(f.host);
    f.emit({ kind: 'status', plugin: 'a', text: 'ok\u001b]52;c;Zm9v\u0007 now' });
    f.emit({ kind: 'toast', plugin: 'a', text: '\rspoof' });
    f.emit({ kind: 'log', plugin: 'a', text: 'line\u001b[1A' });
    await flush();
    expect(ctl.getSnapshot().statuses[0]!.text).toBe('ok]52;c;Zm9v now');
    expect(ctl.getSnapshot().toasts[0]!.text).toBe('spoof');
    expect(history[0]!.text).toBe('line[1A');
    const t = ctl.getSnapshot().band[0]!.tree as Extract<ModElement, { type: 'Text' }>;
    expect(t.children).toEqual(['hi[2Jthere']);
  });

  it('an identical render pass does not wake React, yet presses use the newest onPress', async () => {
    const f = fakeHost();
    let n = 0;
    f.sites['Pane:p'] = () => {
      const mine = ++n;
      return { trees: [{ plugin: 'm', tree: Box([Button('go', { onPress: () => { pressedWith = mine; } })]) }] };
    };
    let pressedWith = 0;
    ctl.attach(f.host);
    f.emit({ kind: 'open', plugin: 'm', id: 'p' });
    await flush();
    let wakes = 0;
    const off = ctl.subscribe(() => { wakes++; });
    for (let i = 0; i < 5; i++) { ctl.invalidate(); await flush(); }
    expect(wakes).toBe(0);
    ctl.handleInput('x', k({ ctrl: true }));
    ctl.handleInput('', k({ tab: true }));
    ctl.handleInput('\r', k({ return: true }));
    await flush();
    expect(pressedWith).toBe(n - 1); // the latest drawn tree's callback (the press redrew once more)
    off();
  });

  it('a burst of bus events wakes React once, and the snapshot is current at once', async () => {
    const f = fakeHost();
    ctl.attach(f.host);
    await flush();
    let wakes = 0;
    const off = ctl.subscribe(() => { wakes++; });
    for (let i = 0; i < 200; i++) f.emit({ kind: 'status', plugin: 'loop', text: `step ${i}` });
    for (let i = 0; i < 5; i++) f.emit({ kind: 'toast', plugin: 'loop', text: `t${i}` });
    expect(ctl.getSnapshot().statuses).toEqual([{ plugin: 'loop', text: 'step 199' }]);
    expect(ctl.getSnapshot().toasts.map(t => t.text)).toEqual(['t2', 't3', 't4']);
    expect(wakes).toBe(0);
    await Promise.resolve();
    expect(wakes).toBe(1);
    // Keys still reach React before the next keypress is read (one wake per key).
    ctl.handleInput('x', k({ ctrl: true }));
    await Promise.resolve();
    expect(wakes).toBe(2);
    expect(ctl.getSnapshot().chord).toBe(true);
    off();
  });

  it('a new host that draws the same tree as the old one still shows it', async () => {
    const a = fakeHost();
    const b = fakeHost();
    a.sites.AbovePrompt = b.sites.AbovePrompt = { trees: [{ plugin: 'x', tree: Text('same') }] };
    ctl.attach(a.host);
    await flush();
    expect(ctl.getSnapshot().band).toHaveLength(1);
    ctl.attach(b.host);
    expect(ctl.getSnapshot().band).toHaveLength(0);
    await flush();
    expect(ctl.getSnapshot().band).toHaveLength(1);
  });
});

describe("the runtime bus's names", () => {
  it('pane.open / pane.close work like open / close; error lines go to the transcript', async () => {
    const f = fakeHost();
    f.sites['Pane:p'] = { trees: [{ plugin: 'm', tree: Text('body') }] };
    ctl.attach(f.host);
    f.emit({ kind: 'pane.open', plugin: 'm', id: 'p', title: 'P', closeOnEscape: true });
    await flush();
    expect(ctl.getSnapshot().panes).toMatchObject([{ id: 'p', title: 'P', closeOnEscape: true, tree: { type: 'Text' } }]);
    f.emit({ kind: 'pane.close', plugin: 'm', id: 'p' });
    expect(ctl.getSnapshot().panes).toEqual([]);
    f.emit({ kind: 'error', plugin: 'm', text: 'tool.call hook skipped: threw boom' });
    expect(history).toEqual([{ kind: 'error', plugin: 'm', text: 'tool.call hook skipped: threw boom' }]);
  });

  it('prompt events reach onPrompt (and are dropped without one)', async () => {
    const prompts: unknown[] = [];
    const withPrompt = new ModsUiController({ onHistory: () => {}, onPrompt: p => prompts.push(p) });
    const f = fakeHost();
    withPrompt.attach(f.host);
    f.emit({ kind: 'prompt', plugin: 'm', text: '[from mod m]\nrun the tests', asUser: false });
    f.emit({ kind: 'prompt', plugin: 'm', text: '   ' });
    expect(prompts).toEqual([{ plugin: 'm', text: '[from mod m]\nrun the tests', asUser: false }]);
    withPrompt.dispose();
    const g = fakeHost();
    ctl.attach(g.host);
    expect(() => g.emit({ kind: 'prompt', plugin: 'm', text: 'x' })).not.toThrow();
  });
});

