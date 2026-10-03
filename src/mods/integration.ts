/**
 * Where QodeX fires mod events. Each integration point (agent loop, surfaces, slash
 * commands) calls one function here; every function returns at once when no mod hooks
 * the event, so QodeX without mods takes the old path unchanged.
 *
 *   tool.call / tool.check / tool.result  modsWrapsToolCall + modsRunToolCall (executeToolCall)
 *   tool.describe                         modsDescribeTools (the tool schemas of each request)
 *   turn.start / turn.complete            modsWrapsRun + modsRunTurn (AgentLoop.run)
 *   turn.step                             modsTurnStep (before each model request)
 *   prompt.section                        modsPromptSections (buildInitialMessages)
 *   prompt.submit                         modsPromptSubmit (TUI, headless, queued prompts)
 *   agent.spawn                           modsAgentSpawn (runSubagent)
 *   session.compact                       modsCompactSkip (auto + manual compaction)
 *   command.run                           modsCommandRun (handleSlashCommand)
 *   ui.render / ui.press                  renderSite / renderSpinner / pressModButton (the TUI)
 */
import * as path from 'path';
import type { AgentEvent, AgentOptions } from '../agent/loop.js';
import type { ToolSchema } from '../llm/types.js';
import type { Message, ToolCall } from '../session/store.js';
import type { PermissionDecision, PermissionEngine, PermissionRequest } from '../security/permissions.js';
import { isCommandTool, isFileEditTool } from '../security/autonomy.js';
import { logger } from '../utils/logger.js';
import { getModCommand } from './command-registry.js';
import { isModElement } from './elements.js';
import { getModsRuntime, modsActive, type ModsRuntime } from './runtime.js';
import { isModToolName } from './tool.js';
import { emitModUi, modPaneOwner } from './ui-bus.js';
import type { ModElement, ModRenderSite } from './types.js';

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function active(): ModsRuntime | null {
  return modsActive() ? getModsRuntime() : null;
}

function modError(plugin: string, text: string): void {
  logger.warn(`mod ${plugin}: ${text}`);
  emitModUi({ kind: 'error', plugin, text });
}

// ── turns ────────────────────────────────────────────────────────────────────

/** Run options of a top-level turn the mods wrapper owns → its turn number. */
const wrappedRuns = new WeakMap<object, number>();

/**
 * Should AgentLoop.run hand this run to modsRunTurn? Top-level runs only (a sub-agent run
 * pins its model with modelOverride or runs in 'subagent' mode), once (the wrapper's own
 * options are marked).
 */
export function modsWrapsRun(options: AgentOptions): boolean {
  if (!active() || wrappedRuns.has(options)) return false;
  return !options.modelOverride && options.mode?.mode !== 'subagent';
}

function latestUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/**
 * turn.start → the run → turn.complete. The run gets its own AbortController (aborted by
 * the caller's signal or $.turn.abort). Each mod's turn.complete `{ text }` becomes a
 * `notice` event ("● <mod>: text", data.source 'mod') — shown, never sent to the model.
 * The latest budget_update / model are kept for $.session.usage().
 */
export async function* modsRunTurn(
  messages: Message[],
  options: AgentOptions,
  inner: (options: AgentOptions) => AsyncGenerator<AgentEvent>,
): AsyncGenerator<AgentEvent> {
  const rt = getModsRuntime();
  if (!rt) { yield* inner(options); return; }
  const turn = ++rt.turnCounter;
  const ac = rt.beginTurn();
  const outer = options.signal;
  const onOuter = () => { if (!ac.signal.aborted) ac.abort(outer?.reason); };
  if (outer?.aborted) ac.abort(outer.reason);
  else outer?.addEventListener('abort', onOuter, { once: true });
  const opts: AgentOptions = { ...options, signal: ac.signal };
  wrappedRuns.set(opts, turn);
  rt.lastRun = { messages, model: rt.lastRun?.model, budget: rt.lastRun?.budget };

  let answer = '';
  let toolCalls = 0;
  let completed = false;
  try {
    if (rt.engine.has('turn.start')) {
      await rt.engine.emit('turn.start', { turn, prompt: latestUserText(messages) }, undefined, { signal: ac.signal });
    }
    for await (const ev of inner(opts)) {
      if (ev.type === 'final') answer = String(ev.data?.content ?? answer);
      else if (ev.type === 'tool_call_start') toolCalls++;
      else if (ev.type === 'budget_update' && rt.lastRun) rt.lastRun.budget = ev.data;
      else if (ev.type === 'thinking_start' && rt.lastRun && ev.data?.model) rt.lastRun.model = String(ev.data.model);
      yield ev;
    }
    completed = true;
  } finally {
    outer?.removeEventListener('abort', onOuter);
    rt.endTurn(ac);
    if (!completed) {
      // The consumer stopped early (or the run threw): still tell the mods; lines go to the bus.
      void turnCompleteLines(rt, turn, answer, true, toolCalls)
        .then(lines => { for (const l of lines) emitModUi({ kind: 'log', plugin: l.plugin, text: l.text }); })
        .catch(() => undefined);
    }
  }
  const lines = await turnCompleteLines(rt, turn, answer, ac.signal.aborted, toolCalls);
  for (const l of lines) {
    yield { type: 'notice', data: { message: `● ${l.plugin}: ${l.text}`, source: 'mod', plugin: l.plugin, text: l.text } };
  }
}

async function turnCompleteLines(rt: ModsRuntime, turn: number, answer: string, aborted: boolean, toolCalls: number): Promise<Array<{ plugin: string; text: string }>> {
  if (!rt.engine.has('turn.complete')) return [];
  const usage = await rt.usage();
  const out: Array<{ plugin: string; text: string }> = [];
  for (const name of rt.engine.modsWith('turn.complete')) {
    try {
      const r = await rt.engine.emit('turn.complete', { turn, answer, aborted, toolCalls, usage }, undefined, { only: name });
      const text = isObj(r.result) && typeof r.result.text === 'string' ? r.result.text.trim() : '';
      if (text) out.push({ plugin: name, text: text.slice(0, 2_000) });
    } catch { /* hooks never throw past the engine; terminal is a no-op */ }
  }
  return out;
}

/**
 * turn.step: one request is about to go to the model. A hook's next({...e, model}) sends
 * this request to another model: `route` is updated in place (provider, model, modelInfo).
 */
export async function modsTurnStep(
  router: { route: (taskClass: any, tokens: number, opts?: { explicitModel?: string }) => any },
  route: { provider: unknown; model: string; modelInfo: unknown },
  options: AgentOptions,
  step: number,
): Promise<void> {
  const turn = wrappedRuns.get(options);
  const rt = turn === undefined ? null : active();
  if (!rt || !rt.engine.has('turn.step')) return;
  const r = await rt.engine.emit('turn.step', { turn, step, model: route.model }, () => undefined, { signal: options.signal });
  const want = isObj(r.payload) ? r.payload.model : undefined;
  if (typeof want !== 'string' || !want.trim() || want === route.model) return;
  try {
    Object.assign(route, router.route('general', 0, { explicitModel: want }));
    logger.info('turn.step: a mod switched this request', { model: route.model });
  } catch (e: any) {
    modError(rt.engine.modsWith('turn.step')[0] ?? 'mods', `turn.step asked for model ${want}, which is not available (${e?.message ?? e})`);
  }
}

// ── tool definitions ─────────────────────────────────────────────────────────

/** Mod tools always ship (relevance gating knows no family for them): add them to `shipped`. */
export function modsKeepModTools(schemas: ToolSchema[], shipped: Set<string>): void {
  if (!getModsRuntime()) return;
  for (const s of schemas) if (isModToolName(s.function.name)) shipped.add(s.function.name);
}

/**
 * tool.describe: once per tool per session, a mod may replace the description the model
 * reads. Rewrites `tools` in place (new schema objects; the registry's are untouched).
 */
export async function modsDescribeTools(tools: ToolSchema[]): Promise<void> {
  const rt = active();
  if (!rt || !rt.engine.has('tool.describe') || tools.length === 0) return;
  for (let i = 0; i < tools.length; i++) {
    const s = tools[i]!;
    const name = s.function.name;
    let desc = rt.describeCache.get(name);
    if (desc === undefined) {
      desc = s.function.description;
      try {
        const r = await rt.engine.emit('tool.describe', { tool: name, description: desc }, (e: any) => ({ description: e.description }));
        if (isObj(r.result) && typeof r.result.description === 'string' && r.result.description.trim()) desc = r.result.description;
      } catch { /* keep QodeX's */ }
      rt.describeCache.set(name, desc);
    }
    if (desc !== s.function.description) tools[i] = { ...s, function: { ...s.function, description: desc } };
  }
}

// ── tool calls ───────────────────────────────────────────────────────────────

interface CheckOverride {
  tool: string;
  operation: string;
  /** Absolute path for an edit tool's operation (tools pass it relative to their cwd). */
  absPath?: string;
  decision: PermissionDecision;
  base: PermissionDecision;
}

const TOOL_CALL_KEYS = new Set(['tool', 'args', 'callId', 'cwd']);

/**
 * The tool.call payload: { tool, args, callId, cwd }, plus every argument mirrored at the
 * top level — a Claude Code mod reads `e.command`, a QodeX mod `e.args.command`. PURE.
 */
export function toolCallPayload(tool: string, args: Record<string, unknown>, callId: string, cwd: string): Record<string, unknown> {
  const mirror: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!TOOL_CALL_KEYS.has(k)) mirror[k] = v;
  return { ...mirror, tool, args, callId, cwd };
}

/**
 * The arguments a tool.call chain ended with: `e.args`, plus top-level fields a Claude
 * Code-style hook changed with next({ ...e, command }). PURE.
 */
export function argsFromToolCallPayload(e: unknown, orig: Record<string, unknown>): Record<string, unknown> {
  if (!isObj(e)) return { ...orig };
  const out: Record<string, unknown> = isObj(e.args) ? { ...e.args } : { ...orig };
  for (const [k, v] of Object.entries(e)) {
    if (TOOL_CALL_KEYS.has(k)) continue;
    if (!(k in orig) || JSON.stringify(v) !== JSON.stringify(orig[k])) out[k] = v;
  }
  return out;
}

/** Tool calls the mods wrapper already ran its chain for → the tool.check override. */
const reentry = new WeakMap<ToolCall, { check?: CheckOverride }>();

/** Should executeToolCall hand this call to modsRunToolCall? */
export function modsWrapsToolCall(tc: ToolCall): boolean {
  if (reentry.has(tc)) return false;
  const rt = active();
  if (!rt) return false;
  return rt.engine.has('tool.call') || rt.engine.has('tool.check') || rt.engine.has('tool.result') || isModToolName(tc.function.name);
}

/** The permission `operation` a tool will ask about, when it can be told from the args. */
function predictOperation(tool: string, args: Record<string, unknown>, cwd: string): { operation: string; absPath?: string } | null {
  if (isCommandTool(tool) && tool !== 'code_run') return typeof args.command === 'string' ? { operation: args.command } : null;
  if (isFileEditTool(tool)) {
    const p = [args.path, args.file_path, args.file].find(v => typeof v === 'string') as string | undefined;
    if (!p) return null;
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    return { operation: path.relative(cwd, abs), absPath: abs };
  }
  return { operation: tool };
}

/**
 * What a mod may make of the permission engine's decision. Never looser than the rules
 * allow: a deny stays a deny; an instruction-file ask, an auto-mode ask and anything
 * Sentinel decides can never become allow. Tightening (allow → ask / deny) is always fine.
 * PURE.
 */
export function clampModDecision(
  base: { decision: PermissionDecision; via?: string },
  wanted: PermissionDecision,
  operation: string,
): PermissionDecision {
  if (wanted === base.decision) return wanted;
  if (base.decision === 'deny') return 'deny';
  if (wanted === 'allow') {
    if (operation.startsWith('sentinel:')) return base.decision;
    if (base.via === 'instruction-file' || base.via === 'auto-policy-ask') return base.decision;
  }
  return wanted;
}

async function precomputeCheck(
  rt: ModsRuntime,
  tool: string,
  args: Record<string, unknown>,
  cwd: string,
  permissions: PermissionEngine,
  signal?: AbortSignal,
): Promise<CheckOverride | undefined> {
  if (typeof (permissions as { explain?: unknown }).explain !== 'function') return undefined;
  const op = predictOperation(tool, args, cwd);
  if (!op || !op.operation) return undefined;
  let base: { decision: PermissionDecision; via?: string };
  try {
    base = permissions.explain({ tool, operation: op.operation, cwd });
  } catch {
    return undefined;
  }
  const r = await rt.engine.emit('tool.check', { tool, operation: op.operation, decision: base.decision },
    () => ({ decision: base.decision }), { signal });
  const wanted = isObj(r.result) && ['allow', 'ask', 'deny'].includes(r.result.decision) ? r.result.decision as PermissionDecision : base.decision;
  const decision = clampModDecision(base, wanted, op.operation);
  if (decision !== wanted) logger.info('tool.check: a mod decision was not applied (the rules do not allow loosening it)', { tool, wanted, kept: decision });
  if (decision === base.decision) return undefined;
  return { tool, operation: op.operation, ...(op.absPath ? { absPath: op.absPath } : {}), decision, base: base.decision };
}

function matchesOverride(o: CheckOverride, req: PermissionRequest): boolean {
  if (req.tool !== o.tool || (req.operation ?? '').startsWith('sentinel:')) return false;
  if (o.absPath) {
    const p = req.operation ?? '';
    const abs = path.isAbsolute(p) ? p : path.resolve(req.cwd ?? process.cwd(), p);
    return abs === o.absPath;
  }
  return req.operation === o.operation;
}

/**
 * The permission engine a tool sees inside a call the mods wrapper ran: identical, except
 * evaluate()/explain() for the request a tool.check hook decided return that decision.
 */
export function modsPermissionsFor(tc: ToolCall, permissions: PermissionEngine): PermissionEngine {
  const o = reentry.get(tc)?.check;
  if (!o || !permissions) return permissions;
  return new Proxy(permissions, {
    get(target, prop, receiver) {
      if (prop === 'evaluate') {
        return (req: PermissionRequest) => {
          const base = target.evaluate(req); // fires the audit hook with the rules' decision
          if (!matchesOverride(o, req)) return base;
          logger.info('tool.check: a mod changed the permission decision', { tool: req.tool, from: base, to: o.decision });
          return o.decision;
        };
      }
      if (prop === 'explain') {
        return (req: PermissionRequest) => {
          const ex = target.explain(req);
          if (!matchesOverride(o, req)) return ex;
          return { ...ex, decision: o.decision, reason: ex.reason ?? 'a mod (tool.check) asks for this', canAlways: false };
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * tool.call around the rest of executeToolCall, then tool.result. `exec` re-enters
 * executeToolCall with the (possibly rewritten) call; tool.check is decided right before.
 *   { deny }   → "[MOD_BLOCKED] …" error result, the tool does not run
 *   { result } → that text is the result, the tool does not run
 *   next({...e, args}) → the tool runs with the new args
 */
export async function modsRunToolCall<R extends { content: string; isError?: boolean; uiEvents: any[] }>(
  tc: ToolCall,
  ctx: { cwd: string; permissions?: PermissionEngine; canonical?: (name: string) => string | undefined; signal?: AbortSignal },
  exec: (tc: ToolCall) => Promise<R>,
): Promise<R> {
  const rt = getModsRuntime();
  let args: Record<string, unknown>;
  try {
    const parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    args = isObj(parsed) ? parsed : {};
  } catch {
    reentry.set(tc, {});
    return exec(tc); // unparsable args: QodeX reports the error as usual
  }
  if (!rt) { reentry.set(tc, {}); return exec(tc); }
  const started = Date.now();
  let full: R | null = null;
  let finalArgs = args;
  const terminal = async (e: any) => {
    finalArgs = argsFromToolCallPayload(e, args);
    const call: ToolCall = { ...tc, function: { ...tc.function, arguments: JSON.stringify(finalArgs) } };
    const mark: { check?: CheckOverride } = {};
    if (rt.engine.has('tool.check') && ctx.permissions) {
      const tool = ctx.canonical?.(call.function.name) ?? call.function.name;
      mark.check = await precomputeCheck(rt, tool, finalArgs, ctx.cwd, ctx.permissions, ctx.signal);
    }
    reentry.set(call, mark);
    full = await exec(call);
    return { result: full.content, isError: full.isError === true };
  };

  const callPayload = toolCallPayload(tc.function.name, args, tc.id, ctx.cwd);
  const res: any = rt.engine.has('tool.call')
    ? (await rt.engine.emit('tool.call', callPayload, terminal, { signal: ctx.signal })).result
    : await terminal(callPayload);

  const ran = full as R | null;
  let out: R;
  if (isObj(res) && typeof res.deny === 'string') {
    out = { content: `[MOD_BLOCKED] A mod refused this call: ${res.deny}\n(Adapt your approach — do not retry the same call.)`, isError: true, uiEvents: ran?.uiEvents ?? [] } as unknown as R;
  } else if (isObj(res) && 'result' in res) {
    const text = typeof res.result === 'string' ? res.result : JSON.stringify(res.result ?? '');
    const isError = typeof res.isError === 'boolean' ? res.isError : ran ? ran.isError === true : false;
    out = ran ? { ...ran, content: text, isError } : { content: text, isError, uiEvents: [] } as unknown as R;
  } else {
    out = ran ?? ({ content: `[MOD_BLOCKED] No mod answered ${tc.function.name}.`, isError: true, uiEvents: [] } as unknown as R);
  }

  if (rt.engine.has('tool.result')) {
    const r = await rt.engine.emit('tool.result', {
      tool: tc.function.name, args: finalArgs, callId: tc.id, result: out.content, isError: out.isError === true, durationMs: Date.now() - started,
    }, (e: any) => ({ result: e.result }), { signal: ctx.signal });
    if (isObj(r.result) && typeof r.result.result === 'string' && r.result.result !== out.content) {
      out = { ...out, content: r.result.result };
    }
  }
  return out;
}

// ── prompts ──────────────────────────────────────────────────────────────────

/**
 * prompt.submit: before a prompt enters the session. Returns the (rewritten) text, the
 * extra context for the model only, or `drop` with the reason when a mod dropped it.
 */
export async function modsPromptSubmit(
  text: string,
  source: 'user' | 'mod' | 'queue' | 'goal' = 'user',
): Promise<{ text: string; context?: string; drop?: string }> {
  const rt = active();
  if (!rt || !rt.engine.has('prompt.submit')) return { text };
  const r = await rt.engine.emit('prompt.submit', { text, source }, () => undefined);
  if (isObj(r.result) && typeof r.result.drop === 'string') return { text, drop: r.result.drop || 'dropped by a mod' };
  const p = isObj(r.payload) ? r.payload : {};
  const out: { text: string; context?: string } = { text: typeof p.text === 'string' ? p.text : text };
  const ctx = Array.isArray(p.context) ? p.context.filter((c: unknown) => typeof c === 'string').join('\n') : typeof p.context === 'string' ? p.context : '';
  if (ctx.trim()) out.context = ctx.trim();
  return out;
}

/** The prompt text the model reads: the prompt plus any mod context after it. */
export function withModContext(text: string, context?: string): string {
  return context ? `${text}\n\n${context}` : text;
}

/** Split a system prompt into named sections at its top-level "# " headings. PURE. */
export function splitPromptSections(text: string): Array<{ name: string; text: string }> {
  const parts = text.split(/\n\n(?=# )/);
  const used = new Map<string, number>();
  return parts.map((part, i) => {
    let base = 'intro';
    if (i > 0 || part.startsWith('# ')) {
      const heading = (part.split('\n', 1)[0] ?? '').replace(/^#\s+/, '').split(/\s+(?:—|–|-|\()/)[0] ?? '';
      base = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `section-${i}`;
    }
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { name: n === 1 ? base : `${base}-${n}`, text: part };
  });
}

/**
 * prompt.section: once per named section of the system prompt (its "# " headings; the
 * text before the first heading is "intro"). `{ text }` replaces a section, `{ text: null }`
 * drops it. Sections rejoin exactly as they were split, so passing through changes nothing.
 */
export async function modsPromptSections(systemPrompt: string): Promise<string> {
  const rt = active();
  if (!rt || !rt.engine.has('prompt.section')) return systemPrompt;
  const out: string[] = [];
  for (const s of splitPromptSections(systemPrompt)) {
    try {
      const r = await rt.engine.emit('prompt.section', { name: s.name, text: s.text }, (e: any) => ({ text: e.text }));
      if (isObj(r.result) && r.result.text === null) continue;
      out.push(isObj(r.result) && typeof r.result.text === 'string' ? r.result.text : s.text);
    } catch {
      out.push(s.text);
    }
  }
  return out.join('\n\n');
}

// ── sub-agents, compaction ───────────────────────────────────────────────────

/**
 * agent.spawn: `{ deny }` refuses the sub-agent; `{ model }` (or next({...e, model}))
 * runs it on another model (resolved through the router; unknown ids are ignored).
 */
export async function modsAgentSpawn(
  router: { resolveModel?: (id: string) => { provider: { name: string }; resolvedId: string } | null },
  spawn: { role: string; task: string; model?: string },
): Promise<{ deny?: string; model?: { provider: string; model: string } }> {
  const rt = active();
  if (!rt || !rt.engine.has('agent.spawn')) return {};
  const r = await rt.engine.emit('agent.spawn', spawn, () => undefined);
  if (isObj(r.result) && typeof r.result.deny === 'string') return { deny: r.result.deny || 'refused by a mod' };
  const want = isObj(r.result) && typeof r.result.model === 'string' ? r.result.model
    : isObj(r.payload) && typeof r.payload.model === 'string' && r.payload.model !== spawn.model ? r.payload.model : undefined;
  if (!want) return {};
  try {
    const resolved = router.resolveModel?.(want);
    if (resolved) return { model: { provider: resolved.provider.name, model: resolved.resolvedId } };
  } catch { /* fall through */ }
  modError(rt.engine.modsWith('agent.spawn')[0] ?? 'mods', `agent.spawn asked for model ${want}, which is not available — kept the original`);
  return {};
}

/** session.compact: a mod's `{ skip }` reason, or null to compact. */
export async function modsCompactSkip(sessionId: string | undefined, tokens: number): Promise<string | null> {
  const rt = active();
  if (!rt || !rt.engine.has('session.compact')) return null;
  const r = await rt.engine.emit('session.compact', { sessionId: sessionId ?? rt.sessionId, tokens }, () => undefined);
  return isObj(r.result) && typeof r.result.skip === 'string' ? (r.result.skip || 'skipped by a mod') : null;
}

// ── commands ─────────────────────────────────────────────────────────────────

const ENGINE_REACHED = Object.freeze({ __qodexEngine: true });

/** Commands a mod can never take over: they are how the user turns a broken mod off. */
const UNINTERCEPTABLE = new Set(['mods', 'reload-mods', 'stop', 'exit', 'quit', 'q']);

/**
 * command.run for `/command args`. A mod answering `{ text }` / `{}` handles the command
 * (built-in commands too, except /mods, /reload-mods, /stop and /exit). A mod command
 * nobody answered reports that. `handled: false` → QodeX runs its own command.
 */
export async function modsCommandRun(command: string, args: string): Promise<{ handled: boolean; text?: string }> {
  const rt = getModsRuntime();
  const modCmd = getModCommand(command);
  if (!rt || !rt.engine.has('command.run') || UNINTERCEPTABLE.has(command)) {
    if (modCmd) return { handled: true, text: `/${command} belongs to mod ${modCmd.plugin}, but no command.run hook of it answered.` };
    return { handled: false };
  }
  const r = await rt.engine.emit('command.run', { command, args }, () => ENGINE_REACHED);
  if (r.result === ENGINE_REACHED || r.result === undefined) {
    if (modCmd) return { handled: true, text: `/${command} belongs to mod ${modCmd.plugin}, but no command.run hook of it answered.` };
    return { handled: false };
  }
  const text = isObj(r.result) && typeof r.result.text === 'string' ? r.result.text : undefined;
  return { handled: true, ...(text ? { text } : {}) };
}

// ── interface ────────────────────────────────────────────────────────────────

export interface ModRenderOutput {
  plugin: string;
  element: ModElement;
}

export interface RenderOptions {
  /** Pane: the pane id ($.ui.open id). */
  requestId?: string;
  viewport?: { columns: number; rows: number };
  signal?: AbortSignal;
}

/**
 * Run the ui.render hooks of a site and return one tree per mod that drew (in mod order).
 * AbovePrompt: every mod's tree, stacked by the caller. Pane: the owning mod only. A hook
 * that draws nothing (returns null or next(e)) contributes nothing. Trees are returned as
 * the hooks built them (Button onPress functions included) — the renderer validates them.
 */
export async function renderSiteDetailed(site: ModRenderSite, props: Record<string, unknown> = {}, opts: RenderOptions = {}): Promise<ModRenderOutput[]> {
  const rt = getModsRuntime();
  if (!rt || !rt.engine.has('ui.render')) return [];
  const payload = {
    component: site,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    surface: rt.surface,
    props,
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
  };
  let mods = rt.engine.modsWith('ui.render');
  if (site === 'Pane') {
    const owner = opts.requestId ? modPaneOwner(opts.requestId) : undefined;
    mods = owner ? mods.filter(m => m === owner) : [];
  }
  const out: ModRenderOutput[] = [];
  for (const name of mods) {
    try {
      const r = await rt.engine.emit('ui.render', payload, () => null, { only: name, signal: opts.signal });
      if (isModElement(r.result) && r.result.type !== 'engine') out.push({ plugin: name, element: r.result });
    } catch { /* a broken mod draws nothing */ }
  }
  return out;
}

/** renderSiteDetailed without the mod names. */
export async function renderSite(site: ModRenderSite, props: Record<string, unknown> = {}, opts: RenderOptions = {}): Promise<ModElement[]> {
  return (await renderSiteDetailed(site, props, opts)).map(o => o.element);
}

/**
 * The Spinner site: the whole chain runs once (all mods). Returns the suffix the mods set
 * with next({...e, props: {...e.props, suffix}}), or a mod's own element when one replaced
 * the spinner (`element` null = draw QodeX's spinner).
 */
export async function renderSpinner(props: Record<string, unknown> = {}): Promise<{ element: ModElement | null; suffix?: string; plugin?: string }> {
  const rt = getModsRuntime();
  if (!rt || !rt.engine.has('ui.render')) return { element: null };
  const engineEl: ModElement = { type: 'engine', ref: 'Spinner' };
  try {
    const r = await rt.engine.emit('ui.render', { component: 'Spinner', surface: rt.surface, props }, () => engineEl);
    const suffix = isObj(r.payload?.props) && typeof r.payload.props.suffix === 'string' && r.payload.props.suffix !== props.suffix
      ? r.payload.props.suffix.slice(0, 200) : undefined;
    if (isModElement(r.result) && r.result.type !== 'engine') return { element: r.result, ...(suffix ? { suffix } : {}) };
    return { element: null, ...(suffix ? { suffix } : {}) };
  } catch {
    return { element: null };
  }
}

/**
 * A Button a mod drew was pressed: run its onPress (bounded like a hook), fire ui.press
 * for that mod, then ask for a redraw.
 */
export async function pressModButton(p: { plugin: string; key: string; requestId?: string; onPress?: () => void | Promise<void> }): Promise<void> {
  const rt = getModsRuntime();
  if (!rt) return;
  if (typeof p.onPress === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => p.onPress!()),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`took longer than ${rt.engine.hookMs} ms`)), rt.engine.hookMs); }),
      ]);
    } catch (e: any) {
      modError(p.plugin, `onPress of button ${p.key} failed: ${e?.message ?? e}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (rt.engine.has('ui.press', p.plugin)) {
    try {
      await rt.engine.emit('ui.press', { key: p.key, ...(p.requestId ? { requestId: p.requestId } : {}) }, undefined, { only: p.plugin });
    } catch { /* */ }
  }
  emitModUi({ kind: 'invalidate', plugin: p.plugin });
}
