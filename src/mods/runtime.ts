/**
 * The mods runtime of this process: loads mods into one engine, gives each its `$`
 * (through RuntimeHost), starts and ends sessions, reloads mods when their files change.
 *
 * One runtime per process (getModsRuntime). Nothing here runs unless initMods() was called
 * — `qodex` (TUI) and `qodex -p` call it; every integration point checks modsActive() first,
 * so QodeX without mods pays nothing.
 */
import * as fsSync from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';
import { registerModInstructionDirs } from '../security/instruction-files.js';
import type { QodexConfig } from '../config/defaults.js';
import type { ModelRouter } from '../llm/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Message } from '../session/store.js';
import { createModApi, endModLifecycle, newModLifecycle, type ModCompleteRequest, type ModCompleteResult, type ModHost, type ModLifecycle, type ModMessage, type ModCommandSpec, type ModToolSpec } from './api.js';
import { addModCommand, getModCommand, listModCommands, removeModCommands } from './command-registry.js';
import { ModEngine, type HookFailure } from './engine.js';
import { discoverMods, envModDirs, hashModDir, importModEntry, readModsState, resolveModOptions, type DiscoveredMod } from './loader.js';
import { userModsDir } from './paths.js';
import { ModTool, modToolName, MOD_TOOL_PREFIX } from './tool.js';
import { clearModUi, emitModUi, modPaneOwner, modUiHasPaneHost, subscribeModUi, type ModUiEvent } from './ui-bus.js';
import { MOD_LIMITS, type ModContextCategory, type ModInfo, type ModRegisterFn, type ModSurface, type ModUsage } from './types.js';

export interface ModsBindings {
  config?: QodexConfig;
  router?: ModelRouter;
  registry?: ToolRegistry;
}

export interface ModsInitOptions {
  cwd: string;
  surface: ModSurface;
  bindings?: ModsBindings;
  /** --mod-dir dirs (QODEX_MOD_DIRS is added). */
  extraDirs?: string[];
  /** Reload user / --mod-dir mods when their files change (TUI; QODEX_MOD_WATCH=1 elsewhere). */
  watch?: boolean;
  /** Skip the built-in mods (tests). */
  noBuiltins?: boolean;
}

interface LoadedMod {
  discovered: DiscoveredMod;
  life: ModLifecycle;
  hash: string;
}

/** What the latest top-level run looked like (for $.session.usage / model). */
export interface RunSnapshot {
  messages: Message[];
  model?: string;
  budget?: Record<string, any>;
}

/** Built-in slash names and aliases a mod command may not take (kept in sync by a test). */
export async function reservedCommandNames(cwd: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { SLASH_CATALOG, RESERVED_SLASH_NAMES } = await import('../cli/slash-catalog.js');
    for (const c of SLASH_CATALOG) out.set(c.name, 'the built-in');
    for (const n of RESERVED_SLASH_NAMES) out.set(n, 'the built-in');
  } catch { /* catalog unavailable — nothing reserved from it */ }
  try {
    const { loadCustomCommands } = await import('../cli/custom-commands.js');
    for (const n of (await loadCustomCommands(cwd)).keys()) if (!out.has(n)) out.set(n, 'the custom command');
  } catch { /* */ }
  try {
    const { slashAliasMap } = await import('../skills/registry.js');
    for (const n of slashAliasMap().keys()) if (!out.has(n)) out.set(n, 'the skill alias');
  } catch { /* */ }
  return out;
}

function redactDeep(v: unknown, depth = 0): unknown {
  const SENSITIVE = /(api[_-]?key|token|password|passwd|secret|authorization|^auth$|access[_-]?key|private[_-]?key|client[_-]?secret|bearer|cookie|credential)/i;
  if (depth > 12) return '[…]';
  if (Array.isArray(v)) return v.map(x => redactDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) && x !== null && x !== undefined && x !== '' ? '[redacted]' : redactDeep(x, depth + 1);
    }
    return out;
  }
  return v;
}

class RuntimeHost implements ModHost {
  constructor(private readonly rt: ModsRuntime) {}

  get surface(): ModSurface { return this.rt.surface; }
  sessionId(): string { return this.rt.sessionId; }
  cwd(): string { return this.rt.cwd; }
  model(): string { return this.rt.lastRun?.model ?? this.rt.bindings.config?.defaults?.model ?? ''; }

  async messages(): Promise<ModMessage[]> {
    let msgs: Message[] = [];
    try {
      const { getSessionStore } = await import('../session/store.js');
      msgs = getSessionStore().loadSession(this.rt.sessionId)?.messages ?? [];
    } catch { /* no store */ }
    if (msgs.length === 0 && this.rt.lastRun) msgs = this.rt.lastRun.messages;
    return msgs.slice(-4096).map(m => ({
      role: m.role,
      text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      ...(m.tool_calls?.length ? { toolUses: m.tool_calls.map(tc => ({ tool: tc.function.name, args: tc.function.arguments })) } : {}),
    }));
  }

  async usage(): Promise<ModUsage> {
    return this.rt.usage();
  }

  async complete(plugin: string, req: ModCompleteRequest): Promise<ModCompleteResult> {
    return this.rt.complete(plugin, req);
  }

  async submitPrompt(plugin: string, p: { text: string; asUser: boolean }): Promise<void> {
    if (!p.text.trim()) return;
    if (this.rt.surface === 'headless') {
      emitModUi({ kind: 'error', plugin, text: '$.prompt.submit is not available in headless mode — nothing was sent' });
      return;
    }
    const text = p.asUser ? p.text : `[from mod ${plugin}]\n${p.text}`;
    emitModUi({ kind: 'prompt', plugin, text, asUser: p.asUser });
  }

  async abortTurn(plugin: string, reason?: string): Promise<void> {
    this.rt.abortTurn(reason ?? `stopped by mod ${plugin}`);
  }

  async settings(): Promise<Record<string, unknown>> {
    let cfg: unknown = this.rt.bindings.config;
    if (!cfg) {
      try { cfg = (await import('../config/loader.js')).getActiveConfig(); } catch { /* */ }
    }
    return (redactDeep(JSON.parse(JSON.stringify(cfg ?? {}))) ?? {}) as Record<string, unknown>;
  }

  async registerCommand(plugin: string, cmd: ModCommandSpec): Promise<void> {
    const name = String(cmd?.name ?? '').replace(/^\//, '');
    if (!MOD_LIMITS.nameRe.test(name)) throw new Error(`"/${name}" refused: a command name is letters, digits, _ and - (up to 64)`);
    const reserved = (await reservedCommandNames(this.rt.cwd)).get(name);
    if (reserved) throw new Error(`"/${name}" refused: it is ${reserved} /${name}`);
    const prior = getModCommand(name);
    if (prior && prior.plugin !== plugin) throw new Error(`"/${name}" refused: mod ${prior.plugin} already added it`);
    addModCommand({
      name,
      description: String(cmd?.description ?? '').slice(0, 200),
      ...(cmd?.argumentHint ? { argumentHint: String(cmd.argumentHint).slice(0, 80) } : {}),
      immediate: cmd?.immediate === true,
      plugin,
    });
  }

  async listCommands(): Promise<Array<{ name: string; description: string; source: string }>> {
    const out: Array<{ name: string; description: string; source: string }> = [];
    try {
      const { SLASH_CATALOG } = await import('../cli/slash-catalog.js');
      for (const c of SLASH_CATALOG) out.push({ name: c.name, description: c.description, source: 'builtin' });
    } catch { /* */ }
    for (const c of listModCommands()) out.push({ name: c.name, description: c.description, source: `mod:${c.plugin}` });
    return out;
  }

  async registerTool(plugin: string, t: ModToolSpec): Promise<string> {
    const registry = this.rt.bindings.registry;
    if (!registry) throw new Error('$.tool.register: no tool registry in this process');
    const short = String(t?.name ?? '');
    if (!MOD_LIMITS.nameRe.test(short)) throw new Error(`$.tool.register: "${short}" — a tool name is letters, digits, _ and - (up to 64)`);
    if (!String(t?.description ?? '').trim()) throw new Error(`$.tool.register: ${short} needs a description (the model decides when to call it from that)`);
    if (!t?.inputSchema || typeof t.inputSchema !== 'object') throw new Error(`$.tool.register: ${short} needs an inputSchema (a JSON schema object)`);
    const full = modToolName(plugin, short);
    if (full.length > 64) throw new Error(`$.tool.register: ${full} is longer than 64 characters — use a shorter tool or mod name`);
    const existing = registry.get(full);
    if (existing && !(existing instanceof ModTool)) throw new Error(`$.tool.register: ${full} is taken`);
    registry.register(new ModTool(plugin, t));
    this.rt.describeCache.delete(full);
    return full;
  }

  async listTools(plugin: string): Promise<string[]> {
    const registry = this.rt.bindings.registry;
    if (!registry) return [];
    return registry.list().map(t => t.name).filter(n => n.startsWith(`${MOD_TOOL_PREFIX}${plugin}__`)).sort();
  }

  async openPane(plugin: string, p: { id: string; title?: string; rows?: number }): Promise<{ isPlaced: boolean; reason?: string }> {
    const id = String(p?.id ?? '');
    if (!MOD_LIMITS.nameRe.test(id)) return { isPlaced: false, reason: 'a pane id is letters, digits, _ and - (up to 64)' };
    const owner = modPaneOwner(id);
    if (owner && owner !== plugin) return { isPlaced: false, reason: `pane "${id}" belongs to mod ${owner}` };
    if (!modUiHasPaneHost()) {
      return { isPlaced: false, reason: this.rt.surface === 'headless' ? 'headless mode draws no panes' : 'no terminal UI is drawing panes' };
    }
    const rows = typeof p?.rows === 'number' && Number.isFinite(p.rows) ? Math.min(Math.max(Math.floor(p.rows), 1), 60) : undefined;
    emitModUi({ kind: 'pane.open', plugin, id, title: String(p?.title ?? id).slice(0, 80), ...(rows ? { rows } : {}) });
    return { isPlaced: true };
  }

  async closePane(plugin: string, id: string): Promise<void> {
    if (modPaneOwner(id) === plugin) emitModUi({ kind: 'pane.close', plugin, id });
  }

  ui(ev: ModUiEvent): void {
    if (ev.kind === 'error') logger.warn(`mod ${ev.plugin}: ${ev.text}`);
    emitModUi(ev);
  }
}

export class ModsRuntime {
  readonly engine = new ModEngine();
  readonly host: ModHost;
  surface: ModSurface;
  cwd: string;
  sessionId = '';
  bindings: ModsBindings;
  /** Cache of tool.describe answers for this session (tool → description). */
  readonly describeCache = new Map<string, string>();
  lastRun: RunSnapshot | null = null;
  /** Top-level turns started this session (turn.* `turn`). */
  turnCounter = 0;
  private turnAbort: AbortController | null = null;
  private discovered: DiscoveredMod[] = [];
  private loaded = new Map<string, LoadedMod>();
  private extraDirs: string[];
  private noBuiltins: boolean;
  private sessionStarted = false;
  private watchers: fsSync.FSWatcher[] = [];
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribeStderr: (() => void) | null = null;
  /** Undo of the --mod-dir dirs registered as agent instruction files. */
  private unregisterModDirs: (() => void) | null = null;

  constructor(opts: ModsInitOptions) {
    this.surface = opts.surface;
    this.cwd = path.resolve(opts.cwd);
    this.bindings = { ...(opts.bindings ?? {}) };
    this.extraDirs = [...new Set([...(opts.extraDirs ?? []), ...envModDirs()])];
    this.noBuiltins = opts.noBuiltins === true;
    // Code in --mod-dir / QODEX_MOD_DIRS runs (and reloads on save): a write there asks in
    // every approval mode, like ~/.qodex/mods — even when the dir is inside the project.
    if (this.extraDirs.length) this.unregisterModDirs = registerModInstructionDirs(this.extraDirs.map(d => path.resolve(this.cwd, d)));
    this.host = new RuntimeHost(this);
    this.engine.onHookError = (f: HookFailure) => {
      const text = `${f.event} hook skipped: ${f.message}`;
      logger.warn(`mod ${f.plugin}: ${text}`);
      emitModUi({ kind: 'error', plugin: f.plugin, text });
    };
    if (this.surface === 'headless') this.printToStderr();
  }

  /** Headless: log / notice / error lines go to stderr; drawing is ignored. */
  private printToStderr(): void {
    this.unsubscribeStderr = subscribeModUi(ev => {
      if (ev.kind === 'log') process.stderr.write(`● ${ev.plugin}: ${ev.text}\n`);
      else if (ev.kind === 'notice') process.stderr.write(`💡 ${ev.plugin}: ${ev.text}\n`);
      else if (ev.kind === 'error') process.stderr.write(`⚠ ${ev.plugin}: ${ev.text}\n`);
    });
  }

  // ── loading ────────────────────────────────────────────────────────────────

  /** Discover every mod and load the enabled, trusted ones (in chain order). */
  async loadAll(): Promise<void> {
    const state = await readModsState();
    this.discovered = await discoverMods({ cwd: this.cwd, extraDirs: this.extraDirs, noBuiltins: this.noBuiltins, state });
    for (const d of this.discovered) {
      if (this.canLoad(d)) await this.loadOne(d, state.config[d.info.name]);
    }
  }

  private canLoad(d: DiscoveredMod): boolean {
    return !d.info.error && d.info.enabled && d.info.trusted && !this.loaded.has(d.info.name);
  }

  private async loadOne(d: DiscoveredMod, savedConfig?: Record<string, unknown>, inline?: ModRegisterFn): Promise<boolean> {
    const name = d.info.name;
    const life = newModLifecycle();
    try {
      const register = inline ?? await importModEntry(d.info.entry);
      const api = createModApi({ name, root: d.info.dir }, this.host, life);
      const on = this.engine.addMod(name, d.rank, api);
      const options = Object.freeze(resolveModOptions(d.manifest, savedConfig));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => register(on, options)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`register() took longer than ${this.engine.hookMs} ms`)), this.engine.hookMs); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const hash = inline ? '' : await hashModDir(d.info.dir);
      this.loaded.set(name, { discovered: d, life, hash });
      d.info.loaded = true;
      delete d.info.error;
      const warnings = this.engine.warningsOf(name);
      if (warnings.length) d.info.warnings = warnings;
      logger.info('Mod loaded', { name, scope: d.info.scope, events: this.engine.eventsOf(name).length });
      return true;
    } catch (e: any) {
      this.engine.removeMod(name);
      endModLifecycle(life);
      d.info.loaded = false;
      d.info.error = e?.message ?? String(e);
      logger.warn(`Mod ${name} did not load: ${d.info.error}`);
      emitModUi({ kind: 'error', plugin: name, text: `did not load: ${d.info.error}` });
      return false;
    }
  }

  /** Unload a mod: hooks, timers, commands, tools, status line and panes go. No session.end. */
  unload(name: string): boolean {
    const m = this.loaded.get(name);
    if (!m) return false;
    this.engine.removeMod(name);
    endModLifecycle(m.life);
    removeModCommands(name);
    try { this.bindings.registry?.unregisterByPrefix(`${MOD_TOOL_PREFIX}${name}__`); } catch { /* */ }
    for (const k of [...this.describeCache.keys()]) this.describeCache.delete(k);
    clearModUi(name);
    this.loaded.delete(name);
    m.discovered.info.loaded = false;
    return true;
  }

  /**
   * Reload one mod (or all): unload, rediscover, load again, then session.start for each
   * reloaded mod when the session already started. Returns the names that loaded.
   */
  async reload(only?: string): Promise<string[]> {
    const names = only ? [only] : [...this.loaded.keys()];
    for (const n of names) this.unload(n);
    const state = await readModsState();
    this.discovered = await discoverMods({ cwd: this.cwd, extraDirs: this.extraDirs, noBuiltins: this.noBuiltins, state });
    const out: string[] = [];
    for (const d of this.discovered) {
      if (only && d.info.name !== only) continue;
      if (this.canLoad(d) && await this.loadOne(d, state.config[d.info.name])) out.push(d.info.name);
    }
    if (this.sessionStarted) for (const n of out) await this.startSessionFor(n);
    return out;
  }

  /** Load a mod that was just enabled / trusted (no-op when it is loaded already). */
  async loadByName(name: string): Promise<{ ok: boolean; error?: string }> {
    if (this.loaded.has(name)) return { ok: true };
    const out = await this.reload(name);
    if (out.includes(name)) return { ok: true };
    const d = this.discovered.find(x => x.info.name === name && !x.info.error?.startsWith('shadowed'))
      ?? this.discovered.find(x => x.info.name === name);
    if (!d) return { ok: false, error: `no mod named ${name}` };
    if (d.info.error) return { ok: false, error: d.info.error };
    if (!d.info.enabled) return { ok: false, error: `${name} is disabled` };
    if (!d.info.trusted) return { ok: false, error: `${name} is a project mod that is not trusted${d.info.trustState === 'changed' ? ' (its files changed since you trusted it)' : ''}` };
    return { ok: false, error: `${name} did not load` };
  }

  /**
   * Load a mod from a register function instead of a dir (tests, embedding QodeX). Same
   * rules as a mod on disk; `rank` 0 = user, 1 = project, 2 = built-in. No session.start —
   * call startSession() (or the caller fires it).
   */
  async addInlineMod(
    name: string,
    register: ModRegisterFn,
    opts: { rank?: number; options?: Record<string, unknown>; dir?: string; description?: string } = {},
  ): Promise<{ ok: boolean; error?: string }> {
    if (!MOD_LIMITS.nameRe.test(name)) return { ok: false, error: `"${name}" is not a valid mod name` };
    this.unload(name);
    const info: ModInfo = {
      name, scope: opts.rank === 2 ? 'builtin' : opts.rank === 1 ? 'project' : 'user', dir: opts.dir ?? this.cwd, entry: '',
      description: opts.description ?? '', enabled: true, trusted: true, loaded: false, events: [], commands: [], tools: [],
    };
    const d: DiscoveredMod = { info, manifest: null, layout: 'qodex', rank: opts.rank ?? 0 };
    this.discovered = [...this.discovered.filter(x => x.info.name !== name), d];
    const ok = await this.loadOne(d, opts.options, register);
    return ok ? { ok } : { ok, error: info.error };
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  loadedNames(): string[] {
    return this.engine.modNames();
  }

  /** Every discovered mod with live events / commands / tools. */
  list(): ModInfo[] {
    return this.discovered.map(d => {
      const info = { ...d.info };
      if (this.loaded.has(info.name)) {
        info.events = this.engine.eventsOf(info.name) as ModInfo['events'];
        info.commands = listModCommands().filter(c => c.plugin === info.name).map(c => c.name);
        info.tools = (this.bindings.registry?.list() ?? []).map(t => t.name).filter(n => n.startsWith(`${MOD_TOOL_PREFIX}${info.name}__`));
      }
      return info;
    });
  }

  // ── session ────────────────────────────────────────────────────────────────

  /** session.start for every loaded mod (each mod's own hooks), before the first prompt. */
  async startSession(sessionId: string, cwd?: string): Promise<void> {
    this.sessionId = sessionId;
    if (cwd) this.cwd = path.resolve(cwd);
    this.sessionStarted = true;
    for (const name of this.engine.modNames()) await this.startSessionFor(name);
  }

  private async startSessionFor(name: string): Promise<void> {
    if (!this.engine.has('session.start', name)) return;
    try {
      await this.engine.emit('session.start', { sessionId: this.sessionId, cwd: this.cwd, surface: this.surface }, undefined, { only: name });
    } catch (e: any) {
      logger.warn(`mod ${name}: session.start failed`, { err: e?.message });
    }
  }

  /** A new session id (after /clear or /resume): no session.start, as in Claude Code. */
  setSession(sessionId: string, cwd?: string): void {
    this.sessionId = sessionId;
    if (cwd) this.cwd = path.resolve(cwd);
    this.describeCache.clear();
    this.turnCounter = 0;
  }

  /** session.end for every mod, all hooks together capped at 1.5 s. */
  async endSession(reason: 'exit' | 'clear' | 'resume' | 'other'): Promise<void> {
    if (!this.engine.has('session.end')) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();
    try {
      await Promise.race([
        this.engine.emit('session.end', { sessionId: this.sessionId, reason }, undefined, { signal: ac.signal }),
        new Promise(resolve => { timer = setTimeout(resolve, MOD_LIMITS.sessionEndTotalMs); }),
      ]);
    } catch (e: any) {
      logger.debug('session.end failed', { err: e?.message });
    } finally {
      if (timer) clearTimeout(timer);
      ac.abort('session ended');
    }
  }

  // ── turns ──────────────────────────────────────────────────────────────────

  /** The AbortController the current top-level turn listens to ($.turn.abort). */
  beginTurn(): AbortController {
    this.turnAbort = new AbortController();
    return this.turnAbort;
  }

  endTurn(ac: AbortController): void {
    if (this.turnAbort === ac) this.turnAbort = null;
  }

  abortTurn(reason: string): void {
    if (this.turnAbort && !this.turnAbort.signal.aborted) this.turnAbort.abort(reason);
  }

  // ── models ─────────────────────────────────────────────────────────────────

  async complete(plugin: string, req: ModCompleteRequest): Promise<ModCompleteResult> {
    const router = this.bindings.router;
    if (!router) return { isAnswered: false, reason: 'no model router in this process' };
    const prompt = String(req?.prompt ?? '');
    if (!prompt.trim()) return { isAnswered: false, reason: 'empty prompt' };
    const cfg: any = this.bindings.config ?? {};
    const want = typeof req?.model === 'string' ? req.model.trim() : 'default';
    const fastModel: string | undefined = cfg.roles?.fast?.model ?? cfg.roles?.offload?.model;
    let explicit: string | undefined;
    if (want === 'fast') explicit = fastModel;
    else if (want && want !== 'default') explicit = want;
    const maxTokens = Math.min(Math.max(Math.floor(Number(req?.maxTokens) || MOD_LIMITS.modelMaxTokensDefault), 1), 64_000);
    const timeoutMs = Math.min(Math.max(Math.floor(Number(req?.timeoutMs) || 60_000), 1_000), 600_000);
    let route: ReturnType<ModelRouter['route']>;
    try {
      route = router.route('general', Math.ceil(prompt.length / 4), explicit ? { explicitModel: explicit } : {});
    } catch (e: any) {
      // An alias QodeX does not know ('haiku' from a Claude Code mod): fall back to fast / default.
      try {
        route = router.route('general', Math.ceil(prompt.length / 4), fastModel && explicit !== fastModel ? { explicitModel: fastModel } : {});
      } catch {
        return { isAnswered: false, reason: e?.message ?? String(e) };
      }
    }
    const messages: Message[] = [];
    if (req?.system) messages.push({ role: 'system', content: String(req.system) });
    messages.push({ role: 'user', content: prompt });
    let text = '';
    try {
      for await (const ev of route.provider.complete({ model: route.model, messages, tools: [], maxTokens, signal: AbortSignal.timeout(timeoutMs) })) {
        if (ev.type === 'text_delta') text += ev.delta ?? '';
        else if (ev.type === 'error') return { isAnswered: false, reason: ev.error ?? 'model error' };
      }
    } catch (e: any) {
      return { isAnswered: false, reason: e?.name === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : (e?.message ?? String(e)) };
    }
    logger.debug('mod model.complete', { plugin, model: route.model, chars: text.length });
    return { isAnswered: true, text };
  }

  // ── usage ──────────────────────────────────────────────────────────────────

  async usage(): Promise<ModUsage> {
    const { countTokens, countTokensJson } = await import('../utils/tokenizer.js');
    const cfg: any = this.bindings.config ?? {};
    const b = this.lastRun?.budget ?? {};
    const msgs = this.lastRun?.messages ?? [];
    const cat = new Map<ModContextCategory, number>([['system', 0], ['tools', 0], ['rules', 0], ['memory', 0], ['messages', 0], ['tool-results', 0]]);
    const add = (c: ModContextCategory, n: number) => cat.set(c, (cat.get(c) ?? 0) + n);
    for (const m of msgs) {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      if (m.role === 'system') {
        for (const part of text.split(/\n\n(?=# )/)) {
          if (/^# Project Rules/.test(part)) add('rules', countTokens(part));
          else if (/^# (Memory|Standing identity)/.test(part)) add('memory', countTokens(part));
          else add('system', countTokens(part));
        }
      } else if (m.role === 'tool') {
        add('tool-results', countTokens(text));
      } else {
        add('messages', countTokens(text) + (m.tool_calls?.length ? countTokensJson(m.tool_calls) : 0));
      }
    }
    const estimated = [...cat.values()].reduce((a, n) => a + n, 0);
    const actual = (Number(b.lastInputTokens) || 0) + (Number(b.lastCacheRead) || 0) + (Number(b.lastCacheCreation) || 0);
    if (actual > estimated) add('tools', actual - estimated);
    const tokens = actual > 0 ? actual : estimated;
    const window = Number(b.contextWindow) || Number(cfg.compaction?.contextWindow) || 32_768;
    const byCategory = [...cat.entries()].map(([category, n]) => ({ category, tokens: n }));
    byCategory.push({ category: 'free', tokens: Math.max(0, window - tokens) });

    let cost: ModUsage['cost'] = { usd: null, inputTokens: 0, outputTokens: 0 };
    try {
      const { getSessionStore } = await import('../session/store.js');
      const meta = this.sessionId ? getSessionStore().loadSession(this.sessionId)?.meta : undefined;
      if (meta) cost = { usd: meta.total_cost_usd ?? null, inputTokens: meta.total_input_tokens ?? 0, outputTokens: meta.total_output_tokens ?? 0 };
    } catch { /* no store */ }
    if (cost.usd === null && typeof b.costUsd === 'number') cost = { ...cost, usd: b.costUsd };

    const limits: ModUsage['limits'] = [];
    const lim = (kind: ModUsage['limits'][number]['kind'], used: number, limit: number) => {
      if (limit > 0) limits.push({ kind, used, limit, percentUsed: Math.round((used / limit) * 1000) / 10 });
    };
    lim('tokens', Number(b.tokens) || 0, Number(cfg.budget?.perTaskMaxTokens) || 0);
    lim('usd', Number(b.costUsd) || 0, Number(cfg.budget?.perTaskLimitUsd) || 0);
    lim('wall', Math.round((Number(b.wallTimeMs) || 0) / 1000), Number(cfg.budget?.perTaskMaxWallSeconds) || 0);
    lim('iterations', Number(b.iterations) || 0, Number(cfg.defaults?.maxIterations) || 0);
    return {
      context: { tokens, window, percent: Math.round((tokens / window) * 1000) / 10, byCategory },
      cost,
      limits,
    };
  }

  // ── hot reload ─────────────────────────────────────────────────────────────

  /** Watch user mods and --mod-dir dirs; a change reloads the mods under it (debounced). */
  startWatching(): void {
    if (this.watchers.length) return;
    const roots = [...new Set([userModsDir(), ...this.extraDirs.map(d => path.resolve(this.cwd, d))])];
    for (const root of roots) {
      try {
        if (!fsSync.statSync(root).isDirectory()) continue;
        const w = fsSync.watch(root, { recursive: true, persistent: false }, (_ev, file) => {
          const rel = typeof file === 'string' ? file : '';
          if (/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(rel)) return;
          this.scheduleReload(root);
        });
        w.on('error', () => { /* a vanished dir stops its watcher */ });
        this.watchers.push(w);
      } catch { /* missing dir: nothing to watch */ }
    }
  }

  stopWatching(): void {
    for (const w of this.watchers) { try { w.close(); } catch { /* */ } }
    this.watchers = [];
    for (const t of this.reloadTimers.values()) clearTimeout(t);
    this.reloadTimers.clear();
  }

  private scheduleReload(root: string): void {
    const prev = this.reloadTimers.get(root);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.reloadTimers.delete(root);
      void this.reloadChangedUnder(root).catch(e => logger.warn('mod hot reload failed', { err: e?.message }));
    }, 200);
    (t as { unref?: () => void }).unref?.();
    this.reloadTimers.set(root, t);
  }

  /** Reload the mods under `root` whose files changed; load new ones; unload removed ones. */
  async reloadChangedUnder(root: string): Promise<string[]> {
    const state = await readModsState();
    const fresh = await discoverMods({ cwd: this.cwd, extraDirs: this.extraDirs, noBuiltins: this.noBuiltins, state });
    const under = (dir: string) => dir === root || dir.startsWith(root + path.sep);
    const changed: string[] = [];
    for (const [name, m] of [...this.loaded]) {
      if (!under(m.discovered.info.dir)) continue;
      const d = fresh.find(x => x.info.name === name && !x.info.error?.startsWith('shadowed'));
      if (!d || d.info.dir !== m.discovered.info.dir) { this.unload(name); changed.push(name); continue; }
      if (await hashModDir(d.info.dir) !== m.hash) changed.push(name);
    }
    for (const d of fresh) {
      if (under(d.info.dir) && !this.loaded.has(d.info.name) && !d.info.error && d.info.enabled && d.info.trusted) changed.push(d.info.name);
    }
    const reloaded: string[] = [];
    for (const name of [...new Set(changed)]) {
      const out = await this.reload(name);
      reloaded.push(...out);
      if (out.length) emitModUi({ kind: 'log', plugin: name, text: 'reloaded' });
    }
    return reloaded;
  }

  /** Stop everything (tests, process exit). */
  dispose(): void {
    this.stopWatching();
    for (const n of [...this.loaded.keys()]) this.unload(n);
    this.unsubscribeStderr?.();
    this.unsubscribeStderr = null;
    this.unregisterModDirs?.();
    this.unregisterModDirs = null;
  }
}

let runtime: ModsRuntime | null = null;

export function getModsRuntime(): ModsRuntime | null {
  return runtime;
}

/** True when mods were initialized and at least one is loaded. */
export function modsActive(): boolean {
  return !!runtime && runtime.loadedNames().length > 0;
}

/**
 * Create this process's runtime (once) and load the mods. A second call updates the
 * bindings / surface and returns the same runtime.
 */
export async function initMods(opts: ModsInitOptions): Promise<ModsRuntime> {
  if (runtime) {
    if (opts.bindings) Object.assign(runtime.bindings, opts.bindings);
    return runtime;
  }
  const rt = new ModsRuntime(opts);
  runtime = rt;
  try {
    await rt.loadAll();
  } catch (e: any) {
    logger.warn('Mods did not load', { err: e?.message });
  }
  if (opts.watch || process.env.QODEX_MOD_WATCH === '1') rt.startWatching();
  return rt;
}

/** Tests: drop the runtime. */
export function resetModsRuntimeForTesting(): void {
  runtime?.dispose();
  runtime = null;
}
