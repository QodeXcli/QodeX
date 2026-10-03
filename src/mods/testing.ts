/**
 * The mods test kit: fire events through a mod's hooks with no session, model or network,
 * stub what QodeX would answer, and check what the mod did.
 *
 *   import { test, expect, mock } from 'qodex/testing'   // or 'claude-code/testing'
 *
 *   test('/tally counts tool calls', async ($, on) => {
 *     on('tool.call', () => ({ result: 'ok' }))        // QodeX's answer when a hook calls next
 *     await $.tool.call({ tool: 'shell', command: 'ls' })
 *     const answer = await $.command.run({ command: 'tally', args: '' })
 *     expect(answer.text).toBe('1 tool call')
 *   })
 *
 * `qodex mod test <dir>` runs every *.test.(ts|mts|js|mjs) under <dir>, each test against
 * a freshly loaded copy of the mod (5 s per test unless it sets timeoutMs). In code,
 * createTestHarness({ dir } | { register }) gives the same `$` / `on` pair.
 *
 * Stubs: an event name answers that event in QodeX's place (`tool.call`, `ui.render`…); a
 * $ call name without the `$.` answers that call and returns `{ value }` or `{ deny }`
 * (`store.get`, `model.complete`, `fs.read`, `process.run`…). With no stub: commands,
 * tools, ui calls and prompts are recorded, the store is in memory, clocks are real, and
 * fs / process / http / model.complete reject with "no implementation for <name>".
 */
import * as fs from 'fs';
import * as path from 'path';
import { createModApi, endModLifecycle, newModLifecycle, type ModHost, type ModLifecycle } from './api.js';
import { findModElement, isModElement, modElementText } from './elements.js';
import { ModEngine, type HookFailure } from './engine.js';
import { toolCallPayload } from './integration.js';
import { importModEntry, importModFile, MOD_TESTING_GLOBAL, readModManifest, resolveModOptions } from './loader.js';
import { reservedCommandNames } from './runtime.js';
import type { ModUiEvent } from './ui-bus.js';
import { MOD_LIMITS, type ModApi, type ModElement, type ModEventName, type ModRegisterFn, type ModSurface, type ModUsage } from './types.js';


type Stub = ($: ModApi, e: any) => unknown;

export interface HarnessUi {
  events: ModUiEvent[];
  logs: string[];
  notices: string[];
  toasts: string[];
  errors: string[];
  /** The mod's current status line. */
  status: string | null;
  panes: Map<string, { title: string; rows?: number }>;
  /** Text sent with $.prompt.submit (framed as QodeX frames it). */
  prompts: string[];
}

export interface TestHarnessOptions {
  /** A mod dir (either layout), loaded fresh. */
  dir?: string;
  /** Or an inline register function. */
  register?: ModRegisterFn;
  /** Name of an inline mod (default: the manifest name, else "test-mod"). */
  name?: string;
  /** userConfig values (over the manifest defaults). */
  options?: Record<string, unknown>;
  cwd?: string;
  surface?: ModSurface;
  /** Rank of the mod under test: 0 user (default), 1 project, 2 built-in. */
  rank?: number;
  /** Other mods loaded alongside (each with its own rank, default 0). */
  plugins?: Array<{ name: string; register: ModRegisterFn; rank?: number }>;
  /** Own-time limit of a hook (default 10 s). */
  hookMs?: number;
  /** Check command names against QodeX's built-in ones (default true). */
  checkReservedNames?: boolean;
}

export interface MountedSite {
  /** The tree the mod drew last (null when it drew nothing). */
  tree(): ModElement | null;
  find(q: { key?: string; type?: string; text?: string | RegExp }): ModElement | undefined;
  press(p: { key: string }): Promise<void>;
  unmount(): Promise<void>;
}

const DEFAULT_TERMINALS: Partial<Record<ModEventName, (e: any) => unknown>> = {
  'prompt.submit': e => ({ text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }),
  'prompt.section': e => ({ text: e.text }),
  'tool.check': e => ({ decision: e.decision }),
  'tool.result': e => ({ result: e.result }),
  'tool.describe': e => ({ description: e.description }),
  'turn.step': e => ({ model: e.model }),
  'ui.render': () => null,
};

function noImpl(name: string): Error {
  return new Error(`no implementation for ${name} — register a stub: on('${name}', ($, e) => ({ value: … }))`);
}

/** One loaded copy of a mod (plus optional companions) with a fake QodeX around it. */
export class TestHarness {
  readonly engine = new ModEngine();
  readonly ui: HarnessUi = { events: [], logs: [], notices: [], toasts: [], errors: [], status: null, panes: new Map(), prompts: [] };
  readonly commands = new Map<string, { name: string; description: string; argumentHint?: string; immediate: boolean; plugin: string }>();
  readonly tools = new Map<string, { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean; plugin: string }>();
  readonly errors: HookFailure[] = [];
  /** The mod under test (known after load). */
  modName = '';
  readonly $: ReturnType<TestHarness['driver']>;
  private stubs = new Map<string, Stub>();
  private started = false;
  private loading: Promise<void> | null = null;
  private lives: ModLifecycle[] = [];
  private store = new Map<string, unknown>();
  private apis = new Map<string, ModApi>();
  private reserved: Map<string, string> | null = null;
  private readonly cwd: string;
  private readonly surface: ModSurface;

  constructor(private readonly opts: TestHarnessOptions) {
    this.cwd = path.resolve(opts.cwd ?? opts.dir ?? process.cwd());
    this.surface = opts.surface ?? 'terminal';
    if (opts.hookMs) { this.engine.hookMs = opts.hookMs; }
    this.engine.onHookError = f => {
      this.errors.push(f);
      this.ui.errors.push(`${f.plugin}: ${f.event} hook skipped: ${f.message}`);
    };
    this.$ = this.driver();
  }

  /** Register a stub. Stubs go before the first call on `$`. */
  on(name: string, stub: Stub): void {
    if (this.started) throw new Error(`on("${name}") after the test first called $ — register stubs first`);
    if (typeof stub !== 'function') throw new Error(`on("${name}"): the stub must be a function`);
    this.stubs.set(name, stub);
  }

  /** A $ call answered by its stub ({ value } / { deny }), else by `fallback`. */
  private async apiCall<T>(name: string, plugin: string, e: unknown, fallback?: () => T | Promise<T>): Promise<T> {
    const stub = this.stubs.get(name);
    if (!stub) {
      if (fallback) return fallback();
      throw noImpl(name);
    }
    const r: any = await stub(this.apis.get(plugin) ?? ({} as ModApi), e);
    if (r && typeof r === 'object' && 'value' in r) return await r.value as T;
    if (r && typeof r === 'object' && typeof r.deny === 'string') throw new Error(r.deny);
    throw new Error(`the ${name} stub returned neither { value } nor { deny }`);
  }

  private apiCallSync<T>(name: string, plugin: string, e: unknown, fallback: () => T): T {
    const stub = this.stubs.get(name);
    if (!stub) return fallback();
    const r: any = stub(this.apis.get(plugin) ?? ({} as ModApi), e);
    if (r && typeof r === 'object' && 'value' in r) return r.value as T;
    if (r && typeof r === 'object' && typeof r.deny === 'string') throw new Error(r.deny);
    throw new Error(`the ${name} stub returned neither { value } nor { deny }`);
  }

  private hostFor(plugin: string): ModHost {
    const h = this;
    const recordUi = (ev: ModUiEvent) => {
      h.ui.events.push(ev);
      if (ev.kind === 'log') h.ui.logs.push(ev.text);
      else if (ev.kind === 'notice') h.ui.notices.push(ev.text);
      else if (ev.kind === 'toast') h.ui.toasts.push(ev.text);
      else if (ev.kind === 'error') h.ui.errors.push(`${ev.plugin}: ${ev.text}`);
      else if (ev.kind === 'status') h.ui.status = ev.text;
      else if (ev.kind === 'pane.close') h.ui.panes.delete(ev.id);
    };
    return {
      surface: h.surface,
      sessionId: () => h.apiCallSync('session.id', plugin, {}, () => 'test-session'),
      cwd: () => h.cwd,
      model: () => h.apiCallSync('session.model', plugin, {}, () => 'test-model'),
      messages: () => h.apiCall('session.messages', plugin, {}, () => []),
      usage: () => h.apiCall<ModUsage>('session.usage', plugin, {}, () => ({
        context: { tokens: 0, window: 200_000, percent: 0, byCategory: [] },
        cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
        limits: [],
      })),
      complete: (_p, req) => h.apiCall('model.complete', plugin, req),
      submitPrompt: (_p, p) => h.apiCall('prompt.submit', plugin, p, () => {
        h.ui.prompts.push(p.asUser ? p.text : `[from mod ${plugin}]\n${p.text}`);
      }),
      abortTurn: (_p, reason) => h.apiCall('turn.abort', plugin, { reason }, () => undefined),
      settings: () => h.apiCall('settings.read', plugin, {}, () => ({})),
      registerCommand: (_p, cmd) => h.apiCall('command.register', plugin, cmd, async () => {
        const name = String(cmd?.name ?? '').replace(/^\//, '');
        if (!MOD_LIMITS.nameRe.test(name)) throw new Error(`"/${name}" refused: a command name is letters, digits, _ and - (up to 64)`);
        if (h.opts.checkReservedNames !== false) {
          h.reserved ??= await reservedCommandNames(h.cwd);
          const r = h.reserved.get(name);
          if (r) throw new Error(`"/${name}" refused: it is ${r} /${name}`);
        }
        const prior = h.commands.get(name);
        if (prior && prior.plugin !== plugin) throw new Error(`"/${name}" refused: mod ${prior.plugin} already added it`);
        h.commands.set(name, { name, description: String(cmd?.description ?? ''), ...(cmd?.argumentHint ? { argumentHint: cmd.argumentHint } : {}), immediate: cmd?.immediate === true, plugin });
      }),
      listCommands: () => h.apiCall('command.list', plugin, {}, () => [...h.commands.values()].map(c => ({ name: c.name, description: c.description, source: `mod:${c.plugin}` }))),
      registerTool: (_p, t) => h.apiCall('tool.register', plugin, t, () => {
        const short = String(t?.name ?? '');
        if (!MOD_LIMITS.nameRe.test(short)) throw new Error(`$.tool.register: "${short}" — a tool name is letters, digits, _ and - (up to 64)`);
        if (!String(t?.description ?? '').trim()) throw new Error(`$.tool.register: ${short} needs a description`);
        const full = `mod__${plugin}__${short}`;
        h.tools.set(full, { name: full, description: t.description, inputSchema: t.inputSchema, readOnly: t.readOnly === true, plugin });
        return full;
      }),
      listTools: () => h.apiCall('tool.list', plugin, {}, () => [...h.tools.values()].filter(t => t.plugin === plugin).map(t => t.name)),
      openPane: (_p, p) => h.apiCall('ui.open', plugin, p, () => {
        h.ui.panes.set(p.id, { title: p.title ?? p.id, ...(p.rows ? { rows: p.rows } : {}) });
        h.ui.events.push({ kind: 'pane.open', plugin, id: p.id, title: p.title ?? p.id, ...(p.rows ? { rows: p.rows } : {}) });
        return { isPlaced: true };
      }),
      closePane: (_p, id) => h.apiCall('ui.close', plugin, { id }, () => { recordUi({ kind: 'pane.close', plugin, id }); }),
      ui: (ev) => {
        const name = ev.kind === 'status' ? 'ui.status' : ev.kind === 'toast' ? 'ui.toast' : ev.kind === 'log' ? 'ui.log' : ev.kind === 'notice' ? 'ui.notice' : '';
        const stub = name ? h.stubs.get(name) : undefined;
        if (stub) { try { stub(h.apis.get(plugin) ?? ({} as ModApi), ev); } catch { /* a stub error never breaks the mod */ } }
        recordUi(ev);
      },
      store: () => ({
        get: (key) => h.apiCall('store.get', plugin, { key }, () => structuredClone(h.store.get(key))),
        set: (key, value) => h.apiCall('store.set', plugin, { key, value }, () => { h.store.set(key, structuredClone(value)); }),
        delete: (key) => h.apiCall('store.delete', plugin, { key }, () => { h.store.delete(key); }),
        keys: () => h.apiCall('store.keys', plugin, {}, () => [...h.store.keys()]),
      }),
      fs: {
        read: (p) => h.apiCall('fs.read', plugin, { path: path.resolve(h.cwd, p) }),
        write: (p, text) => h.apiCall('fs.write', plugin, { path: path.resolve(h.cwd, p), text }),
        exists: (p) => h.apiCall('fs.exists', plugin, { path: path.resolve(h.cwd, p) }),
        list: (p) => h.apiCall('fs.list', plugin, { path: path.resolve(h.cwd, p) }),
      },
      process: { run: (argv, init) => h.apiCall('process.run', plugin, { argv, init: init ?? {} }) },
      http: { fetch: (url, init) => h.apiCall('http.fetch', plugin, { url, init: init ?? {} }) },
      clock: {
        now: () => h.apiCall('clock.now', plugin, {}, () => Date.now()),
        sleep: (ms) => h.apiCall('clock.sleep', plugin, { ms }, () => new Promise<void>(r => { const t = setTimeout(r, ms); (t as any).unref?.(); })),
        after: (ms, fn) => h.apiCallSync('clock.after', plugin, { ms, fn }, () => {
          const t = setTimeout(fn, ms); (t as any).unref?.();
          return { cancel: () => clearTimeout(t) };
        }),
        every: (ms, fn) => h.apiCallSync('clock.every', plugin, { ms, fn }, () => {
          const t = setInterval(fn, Math.max(50, ms)); (t as any).unref?.();
          return { cancel: () => clearInterval(t) };
        }),
      },
      env: { get: (n) => h.apiCallSync('env.get', plugin, { name: n }, () => undefined) },
    };
  }

  private addMod(name: string, rank: number, register: ModRegisterFn, options: Record<string, unknown>, root: string): Promise<void> {
    const life = newModLifecycle();
    this.lives.push(life);
    const api = createModApi({ name, root }, this.hostFor(name), life);
    this.apis.set(name, api);
    const on = this.engine.addMod(name, rank, api);
    return Promise.resolve(register(on, Object.freeze({ ...options }))).then(() => undefined);
  }

  /** Load the mod (and companions). Runs once; the first call on `$` triggers it. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      let register = this.opts.register;
      let options = this.opts.options ?? {};
      let name = this.opts.name ?? 'test-mod';
      let root = this.cwd;
      if (!register) {
        if (!this.opts.dir) throw new Error('createTestHarness needs { dir } or { register }');
        const m = await readModManifest(path.resolve(this.opts.dir));
        if (!m.ok) throw new Error(`${this.opts.dir}: ${m.error}`);
        register = await importModEntry(m.entry);
        name = m.manifest.name;
        root = path.resolve(this.opts.dir);
        options = resolveModOptions(m.manifest, this.opts.options);
      }
      this.modName = name;
      for (const p of this.opts.plugins ?? []) await this.addMod(p.name, p.rank ?? 0, p.register, {}, this.cwd);
      await this.addMod(name, this.opts.rank ?? 0, register, options, root);
    })();
    return this.loading;
  }

  private terminalFor(event: ModEventName): ((e: any) => unknown) | undefined {
    const stub = this.stubs.get(event);
    if (stub) return (e: any) => stub(this.apis.get(this.modName) ?? ({} as ModApi), e);
    if (event === 'tool.call') return () => { throw noImpl('tool.call'); };
    return DEFAULT_TERMINALS[event];
  }

  /** Fire `event` through the hooks; resolves to the chain's result and final payload. */
  async emit(event: ModEventName, payload: unknown, opts: { only?: string } = {}): Promise<{ result: any; payload: any }> {
    this.started = true;
    await this.load();
    return this.engine.emit(event, payload, this.terminalFor(event), opts);
  }

  async fire(event: ModEventName, payload: unknown): Promise<any> {
    return (await this.emit(event, payload)).result;
  }

  private driver() {
    const f = (event: ModEventName, defaults: Record<string, unknown> = {}) =>
      (p: Record<string, unknown> = {}) => this.fire(event, { ...defaults, ...p });
    return {
      fire: (event: ModEventName, payload: unknown) => this.fire(event, payload),
      emit: (event: ModEventName, payload: unknown) => this.emit(event, payload),
      tool: {
        /** `{ tool, args }` or Claude Code style `{ tool, command: 'ls' }` (fields become args). */
        call: (p: Record<string, unknown>) => {
          const { tool, args, callId, cwd, ...rest } = p ?? {};
          const a = args && typeof args === 'object' ? args as Record<string, unknown> : rest;
          return this.fire('tool.call', toolCallPayload(String(tool ?? ''), a, String(callId ?? 'call-1'), String(cwd ?? this.cwd)));
        },
        check: f('tool.check', { operation: '', decision: 'ask' }),
        result: f('tool.result', { args: {}, callId: 'call-1', result: '', isError: false, durationMs: 0 }),
        describe: f('tool.describe', { description: '' }),
      },
      prompt: { submit: f('prompt.submit', { text: '', source: 'user' }), section: f('prompt.section', { name: 'intro', text: '' }) },
      command: { run: f('command.run', { args: '' }) },
      session: {
        start: f('session.start', { sessionId: 'test-session', cwd: this.cwd, surface: this.surface }),
        end: f('session.end', { sessionId: 'test-session', reason: 'exit' }),
        compact: f('session.compact', { sessionId: 'test-session', tokens: 0 }),
      },
      turn: {
        start: f('turn.start', { turn: 1, prompt: '' }),
        step: f('turn.step', { turn: 1, step: 1, model: 'test-model' }),
        complete: f('turn.complete', {
          turn: 1, answer: '', aborted: false, toolCalls: 0,
          usage: { context: { tokens: 0, window: 200_000, percent: 0, byCategory: [] }, cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, limits: [] },
        }),
      },
      agent: { spawn: f('agent.spawn', { role: 'subagent', task: '' }) },
      ui: {
        render: f('ui.render', { component: 'AbovePrompt', surface: this.surface, props: {} }),
        press: f('ui.press', { key: '' }),
        mount: (p: { component?: string; requestId?: string; props?: Record<string, unknown>; surface?: ModSurface; viewport?: { columns: number; rows: number } }) => this.mount(p),
      },
    };
  }

  /** Draw a site through the mod's ui.render hooks; press its Buttons; find elements. */
  async mount(p: { component?: string; requestId?: string; props?: Record<string, unknown>; surface?: ModSurface; viewport?: { columns: number; rows: number } }): Promise<MountedSite> {
    let tree: ModElement | null = null;
    let mounted = true;
    const payload = {
      component: p.component ?? 'AbovePrompt',
      ...(p.requestId ? { requestId: p.requestId } : {}),
      surface: p.surface ?? this.surface,
      props: p.props ?? {},
      ...(p.viewport ? { viewport: p.viewport } : {}),
    };
    const render = async () => {
      const r = await this.emit('ui.render', payload);
      tree = isModElement(r.result) ? r.result : null;
    };
    await render();
    const find = (q: { key?: string; type?: string; text?: string | RegExp }) => findModElement(tree, el => {
      const props = (el as { props?: Record<string, unknown> }).props ?? {};
      if (q.type !== undefined && el.type !== q.type) return false;
      if (q.key !== undefined && props.key !== q.key) return false;
      if (q.text !== undefined) {
        const t = modElementText(el);
        if (typeof q.text === 'string' ? t !== q.text : !q.text.test(t)) return false;
      }
      return true;
    });
    return {
      tree: () => tree,
      find,
      press: async ({ key }) => {
        if (!mounted) throw new Error('press() after unmount()');
        const btn = find({ type: 'Button', key });
        if (!btn) throw new Error(`no Button with key "${key}" in the drawing`);
        const onPress = ((btn as { props?: { onPress?: () => unknown } }).props ?? {}).onPress;
        if (typeof onPress === 'function') await onPress();
        await this.emit('ui.press', { key, ...(p.requestId ? { requestId: p.requestId } : {}) });
        await render();
      },
      unmount: async () => { mounted = false; tree = null; },
    };
  }

  /** Cancel the mods' timers. */
  dispose(): void {
    for (const l of this.lives) endModLifecycle(l);
  }
}

export function createTestHarness(opts: TestHarnessOptions): TestHarness {
  return new TestHarness(opts);
}

// ── mocks ────────────────────────────────────────────────────────────────────

type OnFn = (name: string, stub: Stub) => void;

/** A clock the test moves: timers fire only on advance()/set()/settle(). */
export class MockClock {
  private t: number;
  private seq = 0;
  private timers: Array<{ id: number; at: number; every?: number; fn: () => unknown }> = [];

  constructor(now = 0) { this.t = now; }

  now(): number { return this.t; }

  private add(ms: number, fn: () => unknown, every?: number): { cancel(): void } {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + Math.max(0, ms), ...(every ? { every: Math.max(1, every) } : {}), fn });
    return { cancel: () => { this.timers = this.timers.filter(x => x.id !== id); } };
  }

  after(ms: number, fn: () => unknown): { cancel(): void } { return this.add(ms, fn); }
  every(ms: number, fn: () => unknown): { cancel(): void } { return this.add(ms, fn, ms); }
  sleep(ms: number): Promise<void> { return new Promise(r => { this.add(ms, () => r()); }); }

  async set(target: number): Promise<void> {
    for (;;) {
      const due = this.timers.filter(x => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      if (due.every) due.at += due.every;
      else this.timers = this.timers.filter(x => x.id !== due.id);
      await due.fn();
      await new Promise(r => setImmediate(r));
    }
    this.t = Math.max(this.t, target);
  }

  advance(ms: number): Promise<void> { return this.set(this.t + ms); }
  settle(): Promise<void> { return this.set(this.t); }
}

export const mock = {
  /** Answer $.clock from a MockClock (starts at `now`, default 0). */
  clock(on: OnFn, opts: { now?: number } = {}): MockClock {
    const c = new MockClock(opts.now ?? 0);
    on('clock.now', () => ({ value: c.now() }));
    on('clock.sleep', (_$, e) => ({ value: c.sleep(e.ms) }));
    on('clock.after', (_$, e) => ({ value: c.after(e.ms, e.fn) }));
    on('clock.every', (_$, e) => ({ value: c.every(e.ms, e.fn) }));
    return c;
  },
  /** Answer $.store from an in-memory map that starts with `entries`. */
  store(on: OnFn, entries: Record<string, unknown> = {}): void {
    const m = new Map(Object.entries(entries));
    on('store.get', (_$, e) => ({ value: m.get(e.key) }));
    on('store.set', (_$, e) => { m.set(e.key, e.value); return { value: undefined }; });
    on('store.delete', (_$, e) => { m.delete(e.key); return { value: undefined }; });
    on('store.keys', () => ({ value: [...m.keys()] }));
  },
  /** Answer $.env.get from `vars`. */
  env(on: OnFn, vars: Record<string, string>): void {
    on('env.get', (_$, e) => ({ value: vars[e.name] }));
  },
};

// ── expect ───────────────────────────────────────────────────────────────────

function fmt(v: unknown): string {
  try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter(k => (a as any)[k] !== undefined);
  const kb = Object.keys(b as object).filter(k => (b as any)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual((a as any)[k], (b as any)[k]));
}

function matchObject(a: unknown, b: unknown): boolean {
  if (typeof b !== 'object' || !b) return deepEqual(a, b);
  if (typeof a !== 'object' || !a) return false;
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((x, i) => matchObject(a[i], x));
  return Object.entries(b).every(([k, v]) => matchObject((a as any)[k], v));
}

export class AssertionError extends Error {}

export function expect(actual: unknown) {
  const make = (negate: boolean) => {
    const check = (ok: boolean, msg: string) => {
      if (ok === negate) throw new AssertionError(negate ? `not: ${msg}` : msg);
    };
    return {
      toBe: (v: unknown) => check(Object.is(actual, v), `expected ${fmt(actual)} to be ${fmt(v)}`),
      toEqual: (v: unknown) => check(deepEqual(actual, v), `expected ${fmt(actual)} to equal ${fmt(v)}`),
      toMatch: (re: string | RegExp) => check(typeof actual === 'string' && (typeof re === 'string' ? actual.includes(re) : re.test(actual)), `expected ${fmt(actual)} to match ${String(re)}`),
      toMatchObject: (o: unknown) => check(matchObject(actual, o), `expected ${fmt(actual)} to match ${fmt(o)}`),
      toContain: (x: unknown) => check(typeof actual === 'string' ? actual.includes(String(x)) : Array.isArray(actual) && actual.some(a => deepEqual(a, x)), `expected ${fmt(actual)} to contain ${fmt(x)}`),
      toHaveLength: (n: number) => check((actual as { length?: number } | null)?.length === n, `expected length ${n}, got ${(actual as { length?: number } | null)?.length}`),
      toBeDefined: () => check(actual !== undefined, `expected a value, got undefined`),
      toBeUndefined: () => check(actual === undefined, `expected undefined, got ${fmt(actual)}`),
      toBeNull: () => check(actual === null, `expected null, got ${fmt(actual)}`),
      toBeTruthy: () => check(!!actual, `expected ${fmt(actual)} to be truthy`),
      toBeFalsy: () => check(!actual, `expected ${fmt(actual)} to be falsy`),
      toThrow: (m?: string | RegExp) => {
        let threw = false;
        let msg = '';
        try { (actual as () => unknown)(); } catch (e: any) { threw = true; msg = String(e?.message ?? e); }
        check(threw && (m === undefined || (typeof m === 'string' ? msg.includes(m) : m.test(msg))), `expected a throw${m ? ` matching ${String(m)}` : ''}${threw ? `, got "${msg}"` : ''}`);
      },
    };
  };
  return Object.assign(make(false), { not: make(true) });
}

// ── test() and the runner ────────────────────────────────────────────────────

interface CollectedTest {
  name: string;
  opts: { timeoutMs?: number; plugins?: Array<{ name: string; register: ModRegisterFn; tier?: string; rank?: number }> };
  fn: ($: TestHarness['$'], on: OnFn) => unknown;
}

const kitState: { tests: CollectedTest[]; tier: string } = { tests: [], tier: 'user' };
const TIER_RANK: Record<string, number> = { prepend: -1, user: 0, project: 1, append: 1, builtin: 2 };

/** Declare a test: test(name, fn) or test(name, { timeoutMs, plugins }, fn). */
export function test(name: string, a: CollectedTest['opts'] | CollectedTest['fn'], b?: CollectedTest['fn']): void {
  const fn = (typeof a === 'function' ? a : b) as CollectedTest['fn'];
  if (typeof fn !== 'function') throw new Error(`test("${name}") needs a function`);
  kitState.tests.push({ name: String(name), opts: typeof a === 'function' ? {} : (a ?? {}), fn });
}

/** Load the mod under test at this tier: prepend | user | append | builtin. */
export function tier(t: string): void {
  kitState.tier = t;
}

const KIT = { test, expect, mock, tier, createTestHarness };

/** Make the kit importable as 'qodex/testing' by test files (see loader.ts). */
export function installModTestingGlobal(): void {
  (globalThis as Record<symbol, unknown>)[MOD_TESTING_GLOBAL] = KIT;
}
installModTestingGlobal();

const TEST_FILE_RE = /\.test\.(ts|mts|js|mjs)$/;

export function findModTestFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && TEST_FILE_RE.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export interface ModTestResult {
  file: string;
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Run every *.test.* file under `dir` against the mod in `dir`. Each test gets a freshly
 * loaded copy of the mod. Resolves to the results; prints like `claude plugin test`.
 */
export async function runModTests(dir: string, io: { out: (line: string) => void } = { out: l => console.log(l) }): Promise<{ passed: number; failed: number; results: ModTestResult[] }> {
  installModTestingGlobal();
  const root = path.resolve(dir);
  const files = findModTestFiles(root);
  const results: ModTestResult[] = [];
  const started = Date.now();
  if (files.length === 0) {
    io.out(`No *.test.(ts|mts|js|mjs) files under ${root}.`);
    return { passed: 0, failed: 0, results };
  }
  for (const file of files) {
    const rel = path.relative(root, file);
    io.out(`${rel}:`);
    kitState.tests = [];
    kitState.tier = 'user';
    try {
      await importModFile(file);
    } catch (e: any) {
      results.push({ file: rel, name: '(load)', ok: false, ms: 0, error: e?.message ?? String(e) });
      io.out(`(fail) could not load: ${e?.message ?? e}`);
      continue;
    }
    const tests = kitState.tests.splice(0);
    const rank = TIER_RANK[kitState.tier] ?? 0;
    if (tests.length === 0) {
      results.push({ file: rel, name: '(file)', ok: false, ms: 0, error: 'declares no test(): nothing ran' });
      io.out('(fail) declares no test(): nothing ran');
      continue;
    }
    for (const t of tests) {
      const h = createTestHarness({
        dir: root,
        rank,
        plugins: (t.opts.plugins ?? []).map(p => ({ name: p.name, register: p.register, rank: p.rank ?? TIER_RANK[p.tier ?? 'user'] ?? 0 })),
      });
      const t0 = Date.now();
      const timeoutMs = typeof t.opts.timeoutMs === 'number' ? t.opts.timeoutMs : 5_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => t.fn(h.$, (n, s) => h.on(n, s))),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); }),
        ]);
        const ms = Date.now() - t0;
        results.push({ file: rel, name: t.name, ok: true, ms });
        io.out(`(pass) ${t.name} [${ms}ms]`);
      } catch (e: any) {
        const ms = Date.now() - t0;
        const reported = h.ui.errors.length ? `\n  the engine reported:\n${h.ui.errors.map(x => `    ${x}`).join('\n')}` : '';
        results.push({ file: rel, name: t.name, ok: false, ms, error: `${e?.message ?? e}${reported}` });
        io.out(`(fail) ${t.name} [${ms}ms]\n  ${e?.message ?? e}${reported}`);
      } finally {
        if (timer) clearTimeout(timer);
        h.dispose();
      }
    }
  }
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  io.out('');
  io.out(` ${passed} pass`);
  io.out(` ${failed} fail`);
  io.out(`Ran ${results.length} test${results.length === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'}. [${((Date.now() - started) / 1000).toFixed(2)}s]`);
  return { passed, failed, results };
}
