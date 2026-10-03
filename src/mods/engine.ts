/**
 * The mods engine: every hook on an event forms one middleware chain, in mod load order
 * (user mods, then project mods, then built-in mods — so a user mod can wrap a built-in
 * one), and within a mod in the order register() called on(). The last next() reaches
 * QodeX's own behavior (the `terminal` the caller passes to emit).
 *
 * Rules (they follow Claude Code mods):
 *   - `e` is deeply frozen plain data; next(e2) hands the next hook a frozen copy of e2.
 *   - A hook that returns a result without calling next answers the event: later hooks
 *     and QodeX's behavior do not run. A hook that returns nothing without calling next
 *     passes the event on unchanged.
 *   - Each hook has an own-time limit (MOD_LIMITS.hookMs): time spent inside next() and
 *     inside $ calls does not count, except $.clock.sleep. A hook that throws, times out
 *     or returns a result of the wrong shape is skipped: the chain continues with the event
 *     as that hook received it (or, when it had already called next, with what next
 *     resolved to). The failure is reported through onHookError — one bad mod never breaks
 *     QodeX. `.catch(handler)` on a registration answers in the failed hook's place.
 *   - A synchronous infinite loop in a hook cannot be interrupted (no worker isolation).
 */
import { AsyncLocalStorage } from 'async_hooks';
import { isModElement } from './elements.js';
import { MOD_LIMITS, type ModApi, type ModEventName, type ModMatcher, type ModNext, type ModOn, type ModRegistration } from './types.js';

/** Every event QodeX fires. Hooks on other names load (with a warning) but never run. */
export const MOD_EVENTS: readonly ModEventName[] = [
  'session.start', 'session.end', 'session.compact',
  'prompt.submit', 'prompt.section',
  'tool.call', 'tool.check', 'tool.result', 'tool.describe',
  'turn.start', 'turn.step', 'turn.complete',
  'agent.spawn', 'command.run', 'ui.render', 'ui.press',
];
const KNOWN = new Set<string>(MOD_EVENTS);

type AnyHook = (...args: any[]) => unknown;

interface HookEntry {
  plugin: string;
  event: string;
  matcher?: ModMatcher;
  hook: AnyHook;
  catchHandler?: AnyHook;
  seq: number;
}

interface EngineMod {
  name: string;
  rank: number;
  api: ModApi;
  hooks: HookEntry[];
  warnings: string[];
}

export interface HookFailure {
  plugin: string;
  event: string;
  kind: 'throw' | 'timeout';
  message: string;
}

// ── own-time accounting ──────────────────────────────────────────────────────

/** Own-time clock of one running hook. pause/resume nest ($ calls inside Promise.all). */
class OwnTimer {
  private depth = 0;
  private used = 0;
  private startedAt = 0;
  private handle: ReturnType<typeof setTimeout> | null = null;
  done = false;

  constructor(private readonly limitMs: number, private readonly onTimeout: () => void) {}

  start(): void {
    this.startedAt = Date.now();
    this.arm();
  }

  private arm(): void {
    const left = this.limitMs - this.used;
    if (left <= 0) { this.fire(); return; }
    this.handle = setTimeout(() => this.fire(), left);
    (this.handle as { unref?: () => void }).unref?.();
  }

  private fire(): void {
    if (this.done) return;
    this.done = true;
    this.onTimeout();
  }

  pause(): void {
    if (this.done) return;
    if (this.depth++ === 0) {
      this.used += Date.now() - this.startedAt;
      if (this.handle) clearTimeout(this.handle);
      this.handle = null;
    }
  }

  resume(): void {
    if (this.done || this.depth === 0) return;
    if (--this.depth === 0) {
      this.startedAt = Date.now();
      this.arm();
    }
  }

  remaining(): number {
    const running = this.depth === 0 && !this.done ? Date.now() - this.startedAt : 0;
    return Math.max(0, this.limitMs - this.used - running);
  }

  stop(): void {
    this.done = true;
    if (this.handle) clearTimeout(this.handle);
    this.handle = null;
  }
}

const hookScope = new AsyncLocalStorage<OwnTimer>();

/**
 * Run a $ call: the time it takes does not count against the calling hook's own-time
 * limit. Outside a hook (a timer callback, a test) it just runs.
 */
export async function untimed<T>(fn: () => Promise<T> | T): Promise<T> {
  const t = hookScope.getStore();
  if (!t || t.done) return fn();
  t.pause();
  try {
    return await fn();
  } finally {
    t.resume();
  }
}

/** Run `fn` outside any hook's scope (timer callbacks must not pause a finished hook). */
export function outsideHook<T>(fn: () => T): T {
  return hookScope.exit(fn);
}

// ── payload helpers ──────────────────────────────────────────────────────────

/** A deep copy of plain data (functions are dropped by the JSON fallback). */
export function clonePlain<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch { /* functions inside */ }
  try { return JSON.parse(JSON.stringify(v)) as T; } catch { return v; }
}

export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Does `payload` pass `matcher` (every field equal, in the list, or matching the RegExp)? */
export function matchesMatcher(matcher: ModMatcher | undefined, payload: unknown): boolean {
  if (!matcher) return true;
  const p = (payload ?? {}) as Record<string, unknown>;
  for (const [k, want] of Object.entries(matcher)) {
    const got = p[k];
    if (Array.isArray(want)) {
      if (!want.some(w => w === got)) return false;
    } else if (want instanceof RegExp) {
      want.lastIndex = 0;
      if (typeof got !== 'string' || !want.test(got)) return false;
    } else if (want !== got) {
      return false;
    }
  }
  return true;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optStr = (v: unknown) => v === undefined || typeof v === 'string';

/** Result shape checks; an event not listed accepts anything. */
const RESULT_OK: Partial<Record<string, (v: unknown) => boolean>> = {
  'tool.call': v => isObj(v) && (typeof v.deny === 'string' || 'result' in v),
  'tool.check': v => isObj(v) && (v.decision === 'allow' || v.decision === 'ask' || v.decision === 'deny'),
  'tool.result': v => isObj(v) && typeof v.result === 'string',
  'tool.describe': v => isObj(v) && typeof v.description === 'string',
  'prompt.submit': v => isObj(v) && optStr(v.drop),
  'prompt.section': v => isObj(v) && (typeof v.text === 'string' || v.text === null),
  'session.compact': v => isObj(v) && optStr(v.skip),
  'turn.complete': v => isObj(v) && optStr(v.text),
  'agent.spawn': v => isObj(v) && optStr(v.deny) && optStr(v.model),
  'command.run': v => isObj(v) && optStr(v.text),
  'ui.render': v => v === null || isModElement(v),
};

class HookTimeout extends Error {}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export interface EmitOptions {
  /** Aborts when the event is abandoned (next.signal). */
  signal?: AbortSignal;
  /** Who fired it (next.origin). Default { plugin: 'engine' }. */
  origin?: { plugin: string };
  /** Only this mod's hooks (session.start per mod, ui.render per mod…). */
  only?: string;
}

export class ModEngine {
  private mods = new Map<string, EngineMod>();
  private seq = 0;
  /** Own-time limit of a hook (tests lower it). */
  hookMs: number = MOD_LIMITS.hookMs;
  catchMs: number = MOD_LIMITS.catchMs;
  /** A hook was skipped (threw / timed out / bad result). */
  onHookError?: (f: HookFailure) => void;

  /**
   * Add a mod and return the `on` its register() receives. `rank` orders mods (lower runs
   * first, i.e. outermost); ties break by name.
   */
  addMod(name: string, rank: number, api: ModApi): ModOn {
    const mod: EngineMod = { name, rank, api, hooks: [], warnings: [] };
    this.mods.set(name, mod);
    const bare = new Set<string>();
    const on = (event: string, a: unknown, b?: unknown): ModRegistration => {
      const matcher = typeof a === 'function' ? undefined : a;
      const hook = (typeof a === 'function' ? a : b) as AnyHook;
      if (typeof event !== 'string' || !event) throw new Error('on(): the event name must be a string');
      if (typeof hook !== 'function') throw new Error(`on("${event}"): the hook must be a function`);
      if (matcher !== undefined && !isObj(matcher)) throw new Error(`on("${event}"): the matcher must be an object of fields`);
      if (event !== '*' && !KNOWN.has(event)) mod.warnings.push(`on("${event}"): QodeX never fires this event`);
      if (matcher === undefined) {
        if (bare.has(event)) mod.warnings.push(`on("${event}") is registered twice without a matcher — put both in one hook`);
        bare.add(event);
      }
      const entry: HookEntry = { plugin: name, event, matcher: matcher as ModMatcher | undefined, hook, seq: this.seq++ };
      mod.hooks.push(entry);
      const reg: ModRegistration = {
        catch(handler) {
          if (typeof handler === 'function') entry.catchHandler = handler as AnyHook;
          return reg;
        },
      };
      return reg;
    };
    return on as unknown as ModOn;
  }

  removeMod(name: string): void {
    this.mods.delete(name);
  }

  hasMod(name: string): boolean {
    return this.mods.has(name);
  }

  /** Mod names in chain order. */
  modNames(): string[] {
    return this.sorted().map(m => m.name);
  }

  /** Events a mod hooks, in registration order (deduped). */
  eventsOf(name: string): string[] {
    return [...new Set(this.mods.get(name)?.hooks.map(h => h.event) ?? [])];
  }

  warningsOf(name: string): string[] {
    return [...(this.mods.get(name)?.warnings ?? [])];
  }

  /** Does any mod (or `only`) hook `event` (directly or with '*')? */
  has(event: ModEventName, only?: string): boolean {
    for (const m of this.mods.values()) {
      if (only && m.name !== only) continue;
      if (m.hooks.some(h => h.event === event || h.event === '*')) return true;
    }
    return false;
  }

  /** Mods that hook `event`, in chain order. */
  modsWith(event: ModEventName): string[] {
    return this.sorted().filter(m => m.hooks.some(h => h.event === event || h.event === '*')).map(m => m.name);
  }

  private sorted(): EngineMod[] {
    return [...this.mods.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }

  private chain(event: string, only?: string): HookEntry[] {
    const out: HookEntry[] = [];
    for (const m of this.sorted()) {
      if (only && m.name !== only) continue;
      for (const h of m.hooks) if (h.event === event || h.event === '*') out.push(h);
    }
    return out;
  }

  /**
   * Fire `event`. Resolves to the chain's result and the payload the terminal received
   * (the last hook's rewrite). Without hooks the terminal runs on a copy of `payload`.
   * Throws only what the terminal (QodeX's own behavior) throws.
   */
  async emit<R = unknown>(
    event: ModEventName,
    payload: unknown,
    terminal?: (e: any) => Promise<R> | R,
    opts: EmitOptions = {},
  ): Promise<{ result: R | undefined; payload: any }> {
    const hooks = this.chain(event, opts.only);
    let finalPayload: unknown = payload;
    const signal = opts.signal ?? new AbortController().signal;
    const origin = Object.freeze({ ...(opts.origin ?? { plugin: 'engine' }) });
    const step = async (i: number, e: unknown): Promise<any> => {
      while (i < hooks.length && !matchesMatcher(hooks[i]!.matcher, e)) i++;
      if (i >= hooks.length) {
        finalPayload = clonePlain(e);
        return terminal ? terminal(clonePlain(e)) : undefined;
      }
      return this.invoke(hooks[i]!, event, e, (e2: unknown) => step(i + 1, deepFreeze(clonePlain(e2))), signal, origin);
    };
    if (hooks.length === 0) {
      const result = terminal ? await terminal(clonePlain(payload)) : undefined;
      return { result, payload: clonePlain(payload) };
    }
    const result = await step(0, deepFreeze(clonePlain(payload)));
    return { result, payload: finalPayload };
  }

  private report(h: HookEntry, event: string, kind: 'throw' | 'timeout', message: string): void {
    try { this.onHookError?.({ plugin: h.plugin, event, kind, message }); } catch { /* never */ }
  }

  private async invoke(
    h: HookEntry,
    event: string,
    e: unknown,
    nextFn: (e: unknown) => Promise<any>,
    signal: AbortSignal,
    origin: { plugin: string },
  ): Promise<any> {
    const mod = this.mods.get(h.plugin);
    if (!mod) return nextFn(e);
    const ac = new AbortController();
    const onAbort = () => { if (!ac.signal.aborted) ac.abort(signal.reason); };
    if (signal.aborted) ac.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });

    // Mutated from inside next(); kept in one object so TypeScript does not narrow it.
    const st: { active: boolean; called: boolean; pending: Promise<any> | null; settled: { v: any } | null; nextError: unknown } = {
      active: true, called: false, pending: null, settled: null, nextError: undefined,
    };

    const makeNext = (timer: OwnTimer | null, budgetMs: number): ModNext<any> => {
      const next = ((e2?: unknown) => {
        if (!st.active) return Promise.reject(new Error(`next() called after the ${event} hook of ${h.plugin} was skipped`));
        st.called = true;
        timer?.pause();
        const p = (async () => {
          try {
            const v = await nextFn(e2 === undefined ? e : e2);
            st.settled = { v };
            return v;
          } catch (err) {
            st.nextError = err;
            throw err;
          } finally {
            timer?.resume();
          }
        })();
        st.pending = p;
        return p;
      }) as ModNext<any>;
      next.signal = ac.signal;
      next.origin = origin;
      next.budget = { ms: budgetMs, remainingMs: () => (timer ? timer.remaining() : budgetMs) };
      return next;
    };

    const runTimed = async (fn: (timer: OwnTimer) => unknown, limitMs: number): Promise<
      { ok: true; v: unknown } | { ok: false; kind: 'throw' | 'timeout'; message: string; fromNext: boolean }
    > => {
      let timeoutReject: (err: unknown) => void = () => {};
      const timedOut = new Promise<never>((_, rej) => { timeoutReject = rej; });
      const timer = new OwnTimer(limitMs, () => timeoutReject(new HookTimeout()));
      try {
        timer.start();
        const v = await Promise.race([hookScope.run(timer, () => Promise.resolve().then(() => fn(timer))), timedOut]);
        return { ok: true, v };
      } catch (err) {
        if (err instanceof HookTimeout) return { ok: false, kind: 'timeout', message: `took longer than ${limitMs} ms`, fromNext: false };
        return { ok: false, kind: 'throw', message: `threw ${errText(err)}`, fromNext: st.nextError !== undefined && err === st.nextError };
      } finally {
        timer.stop();
      }
    };

    try {
      const out = await runTimed(timer => h.hook(mod.api, e, makeNext(timer, this.hookMs)), this.hookMs);
      let failure: { kind: 'throw' | 'timeout'; message: string } | null = null;
      if (out.ok) {
        const v = out.v;
        if (v === undefined) {
          if (!st.called) {
            st.active = false; // a late next() from this finished hook must not run the chain twice
            return await nextFn(e);
          }
          if (st.settled) return st.settled.v;
          return await st.pending;
        }
        const check = RESULT_OK[event];
        if (!check || check(v)) return v;
        failure = { kind: 'throw', message: 'returned a result of the wrong shape' };
      } else {
        // QodeX's own behavior failed inside next(): not the mod's fault — pass it up.
        if (out.fromNext) throw st.nextError;
        failure = { kind: out.kind, message: out.message };
      }

      st.active = false;
      this.report(h, event, failure.kind, failure.message);

      if (h.catchHandler) {
        st.active = true;
        const handler = h.catchHandler;
        const errInfo = Object.assign(Object.create(mod.api) as object, { kind: failure.kind, message: failure.message });
        const c = await runTimed(timer => {
          const n = makeNext(timer, this.catchMs) as ModNext<any> & { error?: unknown; called?: boolean };
          n.error = { kind: failure!.kind, message: failure!.message };
          n.called = st.called;
          return handler(errInfo, e, n);
        }, this.catchMs);
        st.active = false;
        if (c.ok && c.v !== undefined) {
          const check = RESULT_OK[event];
          if (!check || check(c.v)) return c.v;
          this.report(h, event, 'throw', 'catch handler returned a result of the wrong shape');
        } else if (!c.ok) {
          if (c.fromNext) throw st.nextError;
          this.report(h, event, c.kind, `catch handler ${c.message}`);
        }
      }

      // Skip the failed hook: what next already produced stands, else continue without it.
      if (st.settled) return st.settled.v;
      if (st.pending) return await st.pending;
      return await nextFn(e);
    } finally {
      st.active = false;
      signal.removeEventListener('abort', onAbort);
    }
  }
}
