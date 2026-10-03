/**
 * The `$` a mod's hooks receive (ModApi in types.ts), built per mod on top of a ModHost —
 * what QodeX itself provides (session, models, commands, tools, the UI bus). The runtime
 * supplies the real host; the test harness (testing.ts) a fake one.
 *
 * Every async call runs through `untimed`, so a hook's own-time limit never counts the
 * time QodeX spends answering it — except $.clock.sleep, which counts on purpose.
 *
 * Limits: relative paths resolve against the session cwd; one fs file is at most 4 MiB;
 * process.run takes an argument list (no shell) with a 30 s default / 10 min max timeout;
 * http.fetch is http(s) only. Timers stop when the mod unloads or reloads.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { runProcess } from '../utils/run-process.js';
import { logger } from '../utils/logger.js';
import { MOD_ELEMENTS } from './elements.js';
import { outsideHook, untimed } from './engine.js';
import { createModStore, type ModStoreApi } from './store.js';
import type { ModUiEvent } from './ui-bus.js';
import { MOD_LIMITS, type ModApi, type ModSurface, type ModUsage } from './types.js';

export type ModMessage = Awaited<ReturnType<ModApi['session']['messages']>>[number];
export type ModCompleteRequest = Parameters<ModApi['model']['complete']>[0];
export type ModCompleteResult = Awaited<ReturnType<ModApi['model']['complete']>>;
export type ModCommandSpec = Parameters<ModApi['command']['register']>[0];
export type ModToolSpec = Parameters<ModApi['tool']['register']>[0];

/** What QodeX provides to every mod's `$`. `plugin` is the calling mod. */
export interface ModHost {
  readonly surface: ModSurface;
  sessionId(): string;
  cwd(): string;
  model(): string;
  messages(): Promise<ModMessage[]>;
  usage(): Promise<ModUsage>;
  complete(plugin: string, req: ModCompleteRequest): Promise<ModCompleteResult>;
  submitPrompt(plugin: string, p: { text: string; asUser: boolean }): Promise<void>;
  abortTurn(plugin: string, reason?: string): Promise<void>;
  settings(): Promise<Record<string, unknown>>;
  registerCommand(plugin: string, cmd: ModCommandSpec): Promise<void>;
  listCommands(): Promise<Array<{ name: string; description: string; source: string }>>;
  registerTool(plugin: string, t: ModToolSpec): Promise<string>;
  listTools(plugin: string): Promise<string[]>;
  openPane(plugin: string, p: { id: string; title?: string; rows?: number }): Promise<{ isPlaced: boolean; reason?: string }>;
  closePane(plugin: string, id: string): Promise<void>;
  /** status / toast / log / notice / invalidate / error lines. */
  ui(ev: ModUiEvent): void;
  /** Optional overrides of the namespaces that reach the machine (the test harness stubs them). */
  store?(plugin: string): ModStoreApi;
  fs?: Partial<ModApi['fs']>;
  process?: Partial<ModApi['process']>;
  http?: Partial<ModApi['http']>;
  clock?: Partial<ModApi['clock']>;
  env?: Partial<ModApi['env']>;
}

/** Per-mod lifecycle state the runtime owns: timers to cancel on unload. */
export interface ModLifecycle {
  timers: Set<{ cancel(): void }>;
  unloaded: boolean;
}

export function newModLifecycle(): ModLifecycle {
  return { timers: new Set(), unloaded: false };
}

/** Cancel a mod's timers and refuse its later calls. */
export function endModLifecycle(life: ModLifecycle): void {
  life.unloaded = true;
  for (const t of [...life.timers]) {
    try { t.cancel(); } catch { /* */ }
  }
  life.timers.clear();
}

const MIN_EVERY_MS = 50;

function oneLine(text: unknown, max = 2_000): string {
  return String(text ?? '').replace(/\s*\n\s*/g, ' ').slice(0, max);
}

function clampMs(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, 1), max);
}

export function createModApi(plugin: { name: string; root: string }, host: ModHost, life: ModLifecycle): ModApi {
  const name = plugin.name;
  const gone = () => new Error(`mod ${name} is unloaded`);
  const call = <T>(fn: () => Promise<T> | T): Promise<T> => (life.unloaded ? Promise.reject(gone()) : untimed(fn));
  const ui = (ev: ModUiEvent) => { if (!life.unloaded) host.ui(ev); };
  const abs = (p: string) => path.resolve(host.cwd(), String(p ?? ''));
  const store = host.store ? host.store(name) : createModStore(name);

  const reportTimerError = (err: unknown) => {
    const text = `timer callback threw ${err instanceof Error ? err.message : String(err)}`;
    logger.warn(`mod ${name}: ${text}`);
    ui({ kind: 'error', plugin: name, text });
  };
  /** Keep a host-made timer so unload cancels it too. */
  const track = (h: { cancel(): void }) => {
    const handle = { cancel: () => { life.timers.delete(handle); h.cancel(); } };
    life.timers.add(handle);
    return handle;
  };
  const runCallback = (fn: () => void | Promise<void>) => outsideHook(() => {
    try {
      return Promise.resolve(fn()).catch(reportTimerError);
    } catch (err) {
      reportTimerError(err);
      return Promise.resolve();
    }
  });

  const api: ModApi = {
    plugin: Object.freeze({ name, root: plugin.root }),
    command: Object.freeze({
      register: (cmd: ModCommandSpec) => call(() => host.registerCommand(name, cmd)),
      list: () => call(() => host.listCommands()),
    }),
    tool: Object.freeze({
      register: async (t: ModToolSpec) => { await call(() => host.registerTool(name, t)); },
      list: () => call(() => host.listTools(name)),
    }),
    model: Object.freeze({
      complete: (req: ModCompleteRequest) => call(() => host.complete(name, req)),
    }),
    prompt: Object.freeze({
      submit: (p: { text: string; asUser?: boolean }) =>
        call(() => host.submitPrompt(name, { text: String(p?.text ?? ''), asUser: p?.asUser === true })),
    }),
    turn: Object.freeze({
      abort: (reason?: string) => call(() => host.abortTurn(name, reason === undefined ? undefined : String(reason))),
    }),
    session: Object.freeze({
      id: () => host.sessionId(),
      cwd: () => host.cwd(),
      model: () => host.model(),
      messages: () => call(() => host.messages()),
      usage: () => call(() => host.usage()),
    }),
    ui: Object.freeze({
      resolve: () => MOD_ELEMENTS,
      invalidate: () => ui({ kind: 'invalidate', plugin: name }),
      open: (p: { id: string; title?: string; rows?: number }) => call(() => host.openPane(name, p)),
      close: (p: { id: string }) => call(() => host.closePane(name, String(p?.id ?? ''))),
      status: (text: string | null) => ui({ kind: 'status', plugin: name, text: text === null || text === undefined ? null : oneLine(text, 300) }),
      toast: (text: string, opts?: { timeoutMs?: number }) =>
        ui({ kind: 'toast', plugin: name, text: oneLine(text, 500), timeoutMs: clampMs(opts?.timeoutMs, MOD_LIMITS.toastMs, 60_000) }),
      log: (text: string) => ui({ kind: 'log', plugin: name, text: String(text ?? '').slice(0, MOD_LIMITS.textChildChars) }),
      notice: (text: string) => ui({ kind: 'notice', plugin: name, text: String(text ?? '').slice(0, MOD_LIMITS.textChildChars) }),
    }),
    fs: Object.freeze({
      read: (p: string) => call(async () => {
        if (host.fs?.read) return host.fs.read(p);
        const file = abs(p);
        // One handle for the size check and the read: the file checked is the file read.
        const fh = await fs.open(file, 'r');
        try {
          const st = await fh.stat();
          if (st.size > MOD_LIMITS.fsFileBytes) throw new Error(`$.fs.read: ${file} is larger than ${MOD_LIMITS.fsFileBytes} bytes`);
          const text = await fh.readFile('utf-8');
          if (Buffer.byteLength(text, 'utf-8') > MOD_LIMITS.fsFileBytes) throw new Error(`$.fs.read: ${file} is larger than ${MOD_LIMITS.fsFileBytes} bytes`);
          return text;
        } finally {
          await fh.close().catch(() => {});
        }
      }),
      write: (p: string, text: string) => call(async () => {
        if (host.fs?.write) return host.fs.write(p, text);
        const file = abs(p);
        const body = String(text ?? '');
        if (Buffer.byteLength(body, 'utf-8') > MOD_LIMITS.fsFileBytes) throw new Error(`$.fs.write: more than ${MOD_LIMITS.fsFileBytes} bytes`);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, body, 'utf-8');
      }),
      exists: (p: string) => call(async () => {
        if (host.fs?.exists) return host.fs.exists(p);
        try { await fs.stat(abs(p)); return true; } catch { return false; }
      }),
      list: (p: string) => call(async () => {
        if (host.fs?.list) return host.fs.list(p);
        const dir = abs(p);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const out: Array<{ name: string; kind: 'file' | 'dir' | 'other'; size: number }> = [];
        for (const ent of entries) {
          const kind = ent.isFile() ? 'file' : ent.isDirectory() ? 'dir' : 'other';
          let size = 0;
          if (kind === 'file') { try { size = (await fs.stat(path.join(dir, ent.name))).size; } catch { /* */ } }
          out.push({ name: ent.name, kind, size });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
      }),
    }),
    process: Object.freeze({
      run: (argv: string[], opts?: { cwd?: string; timeoutMs?: number; stdin?: string }) => call(async () => {
        if (host.process?.run) return host.process.run(argv, opts);
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every(a => typeof a === 'string')) {
          throw new Error('$.process.run takes a non-empty list of strings (no shell)');
        }
        const timeoutMs = clampMs(opts?.timeoutMs, MOD_LIMITS.processDefaultMs, MOD_LIMITS.processMaxMs);
        const r = await runProcess(argv[0]!, argv.slice(1), {
          cwd: opts?.cwd ? abs(opts.cwd) : host.cwd(),
          timeoutMs,
          maxOutputBytes: MOD_LIMITS.fsFileBytes,
          ...(opts?.stdin !== undefined ? { stdin: String(opts.stdin) } : {}),
        });
        if (r.notFound) throw new Error(`$.process.run: ${argv[0]} was not found`);
        if (r.timedOut) throw new Error(`$.process.run: ${argv[0]} was still running after ${timeoutMs} ms`);
        if (r.code === null && /\[spawn error:/.test(r.stderr)) throw new Error(`$.process.run: ${r.stderr.trim()}`);
        return { exitCode: r.code ?? -1, stdout: r.stdout, stderr: r.stderr };
      }),
    }),
    http: Object.freeze({
      fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => call(async () => {
        if (host.http?.fetch) return host.http.fetch(url, init);
        const u = new URL(String(url));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`$.http.fetch: only http and https URLs (got ${u.protocol})`);
        const { proxyFetch } = await import('../utils/proxy-fetch.js');
        const res = await proxyFetch(u.toString(), {
          method: init?.method ?? 'GET',
          headers: init?.headers,
          body: init?.body,
          signal: AbortSignal.timeout(clampMs(init?.timeoutMs, MOD_LIMITS.processDefaultMs, MOD_LIMITS.processMaxMs)),
        });
        let text = await res.text();
        if (text.length > MOD_LIMITS.fsFileBytes) text = text.slice(0, MOD_LIMITS.fsFileBytes);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        return { status: res.status, ok: res.ok, headers, text };
      }),
    }),
    store: Object.freeze({
      get: (key: string) => call(() => store.get(key)),
      set: (key: string, value: unknown) => call(() => store.set(key, value)),
      delete: (key: string) => call(() => store.delete(key)),
      keys: () => call(() => store.keys()),
    }),
    clock: Object.freeze({
      now: () => call(() => (host.clock?.now ? host.clock.now() : Date.now())),
      // Not untimed: a hook that sleeps spends its own time.
      sleep: (ms: number) => (host.clock?.sleep ? host.clock.sleep(ms) : new Promise<void>(resolve => {
        if (life.unloaded) { resolve(); return; }
        const t = setTimeout(() => { life.timers.delete(handle); resolve(); }, clampMs(ms, 0, MOD_LIMITS.processMaxMs));
        (t as { unref?: () => void }).unref?.();
        const handle = { cancel: () => { clearTimeout(t); resolve(); } };
        life.timers.add(handle);
      })),
      after: (ms: number, fn: () => void | Promise<void>) => {
        if (life.unloaded || typeof fn !== 'function') return { cancel() {} };
        if (host.clock?.after) return track(host.clock.after(ms, () => runCallback(fn)));
        const t = setTimeout(() => { life.timers.delete(handle); void runCallback(fn); }, clampMs(ms, 0, 2_147_483_647));
        (t as { unref?: () => void }).unref?.();
        const handle = { cancel: () => { clearTimeout(t); life.timers.delete(handle); } };
        life.timers.add(handle);
        return handle;
      },
      every: (ms: number, fn: () => void | Promise<void>) => {
        if (life.unloaded || typeof fn !== 'function') return { cancel() {} };
        if (host.clock?.every) return track(host.clock.every(ms, () => runCallback(fn)));
        let running = false;
        const t = setInterval(() => {
          if (running) return; // never pile up behind a slow callback
          running = true;
          void runCallback(fn).finally(() => { running = false; });
        }, Math.max(MIN_EVERY_MS, clampMs(ms, MIN_EVERY_MS, 2_147_483_647)));
        (t as { unref?: () => void }).unref?.();
        const handle = { cancel: () => { clearInterval(t); life.timers.delete(handle); } };
        life.timers.add(handle);
        return handle;
      },
    }),
    env: Object.freeze({
      get: (n: string) => (host.env?.get ? host.env.get(n) : process.env[String(n)]),
    }),
    settings: Object.freeze({
      read: () => call(() => host.settings()),
    }),
  };
  return Object.freeze(api);
}
