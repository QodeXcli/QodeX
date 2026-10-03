/**
 * QodeX mods — the shared contract.
 *
 * A mod is a small JavaScript/TypeScript module that hooks into QodeX itself: it can hold
 * or rewrite a tool call, rewrite a prompt, draw UI above the prompt or under it, add a
 * slash command or a tool, call a model, run work on a timer, or replace a built-in step.
 * The shape follows Claude Code mods (register(on, options), middleware hooks with
 * `($, e, next)`, the `$` mods API) so a simple Claude Code mod runs in QodeX unchanged.
 *
 * Layout (either):
 *   ~/.qodex/mods/<name>/mod.json            { name, description?, version?, main?, userConfig? }
 *   ~/.qodex/mods/<name>/register.(js|mjs|ts|mts)
 * or a Claude Code plugin directory:
 *   <dir>/.claude-plugin/plugin.json + <dir>/hooks/hooks.json { "modules": ["./register.js"] }
 *
 * Project mods (<cwd>/.qodex/mods/<name>) are code from the repository: they load only after
 * the user trusts them (`qodex mod trust <name>` / `/mods trust <name>`).
 *
 * Mods are code that runs with the user's permissions. Writing into a mods directory is an
 * agent-instruction-file write (src/security/instruction-files.ts): it asks in every mode.
 */

// ── events ────────────────────────────────────────────────────────────────────

/** Every event a mod can hook, with its payload (`e`) and what a hook may return. */
export interface ModEventMap {
  /** Once per loaded mod before the first prompt (and after that mod reloads). */
  'session.start': { payload: { sessionId: string; cwd: string; surface: ModSurface }; result: void };
  /** The session ends (exit, /clear, /resume). */
  'session.end': { payload: { sessionId: string; reason: 'exit' | 'clear' | 'resume' | 'other' }; result: void };
  /** The conversation is about to be compacted. `{ skip: reason }` skips it. */
  'session.compact': { payload: { sessionId: string; tokens: number }; result: void | { skip: string } };

  /** A prompt is submitted. Rewrite `text`, add `context` (appended for the model only), or `{ drop }`. */
  'prompt.submit': { payload: { text: string; context?: string; source: 'user' | 'mod' | 'queue' | 'goal' }; result: void | { drop: string } };
  /** Once per named system-prompt section. `{ text }` replaces it, `{ text: null }` omits it. */
  'prompt.section': { payload: { name: string; text: string }; result: void | { text: string | null } };

  /** A tool is about to run. `{ deny }` refuses, `{ result }` answers without running, next({...e, args}) rewrites. */
  'tool.call': { payload: { tool: string; args: Record<string, unknown>; callId: string; cwd: string }; result: void | { deny: string } | { result: string; isError?: boolean } };
  /** After the permission engine decided; `{ decision }` overrides (a mod can never turn a hard deny / Sentinel-critical into allow). */
  'tool.check': { payload: { tool: string; operation: string; decision: 'allow' | 'ask' | 'deny' }; result: void | { decision: 'allow' | 'ask' | 'deny' } };
  /** A tool ran. Observe or rewrite the result text the model reads. */
  'tool.result': { payload: { tool: string; args: Record<string, unknown>; callId: string; result: string; isError: boolean; durationMs: number }; result: void | { result: string } };
  /** Once per tool when its definition is first sent to the model. `{ description }` replaces it. */
  'tool.describe': { payload: { tool: string; description: string }; result: void | { description: string } };

  /** A user turn begins. */
  'turn.start': { payload: { turn: number; prompt: string }; result: void };
  /** One request is about to go to the model; next({...e, model}) switches the model for this step. */
  'turn.step': { payload: { turn: number; step: number; model: string }; result: void };
  /** A turn ended. `{ text }` shows a dim line under the answer (the model does not read it). */
  'turn.complete': { payload: { turn: number; answer: string; aborted: boolean; toolCalls: number; usage: ModUsage }; result: void | { text: string } };

  /** A sub-agent is about to start. `{ deny }` or `{ model }`. */
  'agent.spawn': { payload: { role: string; task: string; model?: string }; result: void | { deny: string } | { model: string } };

  /** A slash command registered by a mod (or any command, matched by name) is about to run. */
  'command.run': { payload: { command: string; args: string }; result: void | { text?: string } };

  /** A render site is about to be drawn. Return a tree (see ModElement) or next(e) for nothing. */
  'ui.render': { payload: { component: ModRenderSite; requestId?: string; surface: ModSurface; props: Record<string, unknown>; viewport?: { columns: number; rows: number } }; result: ModElement | null | void };
  /** A Button a mod drew was pressed (by hotkey or Enter). */
  'ui.press': { payload: { key: string; requestId?: string }; result: void };
}

export type ModEventName = keyof ModEventMap;
export type ModPayload<E extends ModEventName> = ModEventMap[E]['payload'];
export type ModResult<E extends ModEventName> = ModEventMap[E]['result'];

export type ModSurface = 'terminal' | 'headless' | 'control';

/** Where a mod can draw in the TUI. */
export type ModRenderSite =
  /** The band directly above the prompt input, shared by all mods (context bar, checks…). */
  | 'AbovePrompt'
  /** A framed region above the prompt opened with $.ui.open({ id }); `requestId` is that id. */
  | 'Pane'
  /** The spinner line while a turn runs: next({...e, props: {...e.props, suffix}}) to add text. */
  | 'Spinner';

/** Filter on payload fields: a value, a list of accepted values, or a RegExp (strings). `*` event matches all. */
export type ModMatcher = Record<string, string | number | boolean | RegExp | Array<string | number | boolean>>;

/** The rest of the chain: later mods, then QodeX's own behavior. */
export interface ModNext<E extends ModEventName> {
  (e: ModPayload<E>): Promise<ModResult<E>>;
  /** Aborts when the event is abandoned (the user interrupts, /stop). */
  signal: AbortSignal;
  /** Who fired the event: QodeX itself is { plugin: 'engine' }. */
  origin: { plugin: string };
  /** This hook's own time limit (ms) and what is left. */
  budget: { ms: number; remainingMs: () => number };
}

export type ModHook<E extends ModEventName> = (
  $: ModApi,
  e: Readonly<ModPayload<E>>,
  next: ModNext<E>,
) => Promise<ModResult<E> | void> | ModResult<E> | void;

export interface ModRegistration {
  /** Error handler for this hook (a throw or a timeout). Without one the hook is skipped and the error logged. */
  catch(handler: (err: { kind: 'throw' | 'timeout'; message: string }) => void): ModRegistration;
}

export interface ModOn {
  <E extends ModEventName>(event: E, hook: ModHook<E>): ModRegistration;
  <E extends ModEventName>(event: E, matcher: ModMatcher, hook: ModHook<E>): ModRegistration;
  (event: '*', hook: ModHook<ModEventName>): ModRegistration;
}

/** What a hooks module exports. `options` are the manifest's userConfig values with defaults. */
export type ModRegisterFn = (on: ModOn, options: Record<string, unknown>) => void | Promise<void>;

// ── UI elements ──────────────────────────────────────────────────────────────

/** A plain-data element tree; the TUI renders it with Ink. Unknown elements/props are refused. */
export type ModElement =
  | { type: 'Box'; props: ModBoxProps; children: ModElement[] }
  | { type: 'Text'; props: ModTextProps; children: Array<string | ModElement> }
  | { type: 'Button'; props: { key: string; label: string; hotkey?: string; plain?: boolean; dimColor?: boolean; onPress?: () => void | Promise<void> }; children: [] }
  | { type: 'Link'; props: { href: string; label?: string }; children: [] }
  | { type: 'Markdown'; props: { text: string; dimColor?: boolean }; children: [] }
  | { type: 'Bar'; props: ModBarProps; children: [] }
  /** The engine's own drawing at a site QodeX draws (Spinner), as returned by next(e). */
  | { type: 'engine'; ref: string };

export interface ModBoxProps {
  key?: string;
  flexDirection?: 'row' | 'column';
  columnGap?: number; rowGap?: number; gap?: number;
  padding?: number; paddingX?: number; paddingY?: number;
  marginTop?: number; marginBottom?: number;
  width?: number | string;
  borderStyle?: 'single' | 'round' | 'double' | 'bold';
  borderColor?: string;
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between';
}

export interface ModTextProps {
  color?: string; backgroundColor?: string;
  bold?: boolean; italic?: boolean; underline?: boolean; dimColor?: boolean; inverse?: boolean;
  wrap?: 'wrap' | 'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end';
}

/** A stacked horizontal bar (e.g. the context window by category). Width defaults to the band. */
export interface ModBarProps {
  key?: string;
  width?: number;
  segments: Array<{ label: string; value: number; color: string }>;
  /** Total the segments are a share of (default: their sum). The rest is drawn as empty. */
  total?: number;
  showLegend?: boolean;
}

/** Element factories handed out by $.ui.resolve(e): `Text({ children: ['hi'], bold: true })`. */
export interface ModElements {
  Box(props: ModBoxProps & { children?: Array<ModElement | null | undefined | false> }): ModElement;
  Text(props: ModTextProps & { children?: Array<string | number | ModElement | null | undefined | false> }): ModElement;
  Button(props: { key: string; label: string; hotkey?: string; plain?: boolean; dimColor?: boolean; onPress?: () => void | Promise<void> }): ModElement;
  Link(props: { href: string; label?: string }): ModElement;
  Markdown(props: { text: string; dimColor?: boolean }): ModElement;
  Bar(props: ModBarProps): ModElement;
}

// ── the mods API ($) ─────────────────────────────────────────────────────────

export interface ModUsage {
  /** Context window use for the NEXT request: tokens, window size, percent. */
  context: { tokens: number; window: number; percent: number; byCategory: Array<{ category: ModContextCategory; tokens: number }> };
  /** Session spend so far (null when the price is unknown). */
  cost: { usd: number | null; inputTokens: number; outputTokens: number };
  /** Budget caps and how much of each is used (wrap-up allowance included). */
  limits: Array<{ kind: 'tokens' | 'usd' | 'wall' | 'iterations'; used: number; limit: number; percentUsed: number }>;
}

export type ModContextCategory = 'system' | 'tools' | 'rules' | 'memory' | 'messages' | 'tool-results' | 'free';

export interface ModApi {
  plugin: { name: string; root: string };
  command: {
    /** Add a slash command. Throws for a name a built-in command uses. `immediate` runs it during a turn. */
    register(cmd: { name: string; description: string; argumentHint?: string; immediate?: boolean }): Promise<void>;
    list(): Promise<Array<{ name: string; description: string; source: string }>>;
  };
  tool: {
    /** Add a tool for the model, named `mod__<plugin>__<name>`; answer it in a tool.call hook. */
    register(t: { name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean }): Promise<void>;
    list(): Promise<string[]>;
  };
  model: {
    /** One prompt to a model outside the conversation (the user's providers and keys). Never rejects on API errors. */
    complete(req: { prompt: string; system?: string; model?: 'fast' | 'default' | string; maxTokens?: number; timeoutMs?: number }): Promise<{ isAnswered: true; text: string } | { isAnswered: false; reason: string }>;
  };
  prompt: {
    /** Start a turn once the session is idle. Without asUser the model is told which mod sent it. */
    submit(p: { text: string; asUser?: boolean }): Promise<void>;
  };
  turn: { abort(reason?: string): Promise<void> };
  session: {
    id(): string;
    cwd(): string;
    model(): string;
    /** The transcript: newest 4096 entries as { role, text, toolUses }. */
    messages(): Promise<Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; text: string; toolUses?: Array<{ tool: string; args: string }> }>>;
    usage(): Promise<ModUsage>;
  };
  ui: {
    /** Element factories for a ui.render hook. */
    resolve(e?: unknown): ModElements;
    /** Ask QodeX to run ui.render hooks again (throttled to ~10/s). */
    invalidate(event?: 'ui.render'): void;
    /** Open / close a Pane (a framed region above the prompt). */
    open(p: { id: string; title?: string; rows?: number }): Promise<{ isPlaced: boolean; reason?: string }>;
    close(p: { id: string }): Promise<void>;
    /** One line under the prompt, prefixed with the mod name, until replaced (null clears it). */
    status(text: string | null): void;
    /** A short notice that disappears after a few seconds. */
    toast(text: string, opts?: { timeoutMs?: number }): void;
    /** A dim line in the transcript the model does not read. */
    log(text: string): void;
    /** A highlighted heads-up line in the transcript ("💡 <mod>: …"). The model does not read it. */
    notice(text: string): void;
  };
  fs: {
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<Array<{ name: string; kind: 'file' | 'dir' | 'other'; size: number }>>;
  };
  process: {
    /** Argument list, no shell. Resolves whatever the exit code; rejects on spawn failure or timeout (30s default, 10 min max). */
    run(argv: string[], opts?: { cwd?: string; timeoutMs?: number; stdin?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  http: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }> };
  /** JSON key-value store of this mod, kept between sessions (~/.qodex/mods-store/<name>.json, 4 MiB). */
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>; keys(): Promise<string[]> };
  clock: {
    now(): Promise<number>;
    sleep(ms: number): Promise<void>;
    after(ms: number, fn: () => void | Promise<void>): { cancel(): void };
    every(ms: number, fn: () => void | Promise<void>): { cancel(): void };
  };
  env: { get(name: string): string | undefined };
  /** QodeX's effective config (read-only; secrets redacted). */
  settings: { read(): Promise<Record<string, unknown>> };
}

// ── manifest / loader ────────────────────────────────────────────────────────

export interface ModManifest {
  name: string;
  description?: string;
  version?: string;
  /** Entry file relative to the mod dir (default: register.{js,mjs,ts,mts}). */
  main?: string;
  userConfig?: Record<string, { type: 'string' | 'number' | 'boolean'; default?: unknown; description?: string }>;
  /** Built-in mods only: on until the user switches it off (default true). `enabledByDefault` is read too. */
  defaultEnabled?: boolean;
}

export type ModScope = 'builtin' | 'user' | 'project';

export interface ModInfo {
  name: string;
  scope: ModScope;
  dir: string;
  entry: string;
  description: string;
  enabled: boolean;
  /** Project mods need the user's trust before they load. */
  trusted: boolean;
  loaded: boolean;
  error?: string;
  events: ModEventName[];
  commands: string[];
  tools: string[];
  /** Loaded from --mod-dir / QODEX_MOD_DIRS (session only, scope 'user'). */
  fromModDir?: boolean;
  /** Project mods: 'untrusted' (never trusted), 'changed' (files changed since trust), 'trusted'. */
  trustState?: 'not-needed' | 'trusted' | 'untrusted' | 'changed';
  /** Load warnings (unknown events, a duplicate bare hook…). */
  warnings?: string[];
}

/** Limits (QodeX follows Claude Code's where they apply). */
export const MOD_LIMITS = {
  hookMs: 10_000,
  catchMs: 1_000,
  sessionEndTotalMs: 1_500,
  processDefaultMs: 30_000,
  processMaxMs: 600_000,
  modelMaxTokensDefault: 1024,
  fsFileBytes: 4 * 1024 * 1024,
  storeBytes: 4 * 1024 * 1024,
  textChildChars: 10_000,
  redrawPerSecond: 10,
  toastMs: 4_000,
  nameRe: /^[A-Za-z0-9_-]{1,64}$/,
} as const;
