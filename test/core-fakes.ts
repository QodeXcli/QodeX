/**
 * Test doubles for driving a REAL AgentLoop end-to-end without a model server:
 * a scripted provider, a router that always routes to it, a small tool registry and
 * scriptable tools. Used by test/core-*.test.ts.
 *
 * IMPORTANT: import this module DYNAMICALLY, after pointing process.env.HOME at a
 * temp dir — several src modules compute ~/.qodex paths at import time and the loop
 * opens the session DB / transaction journal there.
 */
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../src/tools/base.js';
import type { CompletionRequest, ModelInfo, StreamEvent, ToolSchema } from '../src/llm/types.js';
import type { ToolExecutionMode } from '../src/tools/registry.js';
import { DEFAULT_CONFIG, type QodexConfig } from '../src/config/defaults.js';

export type ToolImpl = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;

/** A tool whose behavior is a plain function. Accepts any object args. */
export class FakeTool extends Tool<Record<string, unknown>> {
  name: string;
  description: string;
  argsSchema = z.object({}).passthrough() as unknown as z.ZodType<Record<string, unknown>>;
  isReadOnly: boolean;
  isDestructive = false;
  calls: Array<Record<string, unknown>> = [];
  private impl: ToolImpl;

  constructor(name: string, impl: ToolImpl = () => ({ content: `ok:${name}` }), opts: { readOnly?: boolean; timeoutSeconds?: number } = {}) {
    super();
    this.name = name;
    this.description = `fake ${name}`;
    this.isReadOnly = opts.readOnly ?? false;
    if (opts.timeoutSeconds !== undefined) this.timeoutSeconds = opts.timeoutSeconds;
    this.impl = impl;
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    this.calls.push(args);
    return this.impl(args, ctx);
  }
}

/** Minimal ToolRegistry stand-in with the same mode filtering as the real one. */
export class FakeRegistry {
  private tools = new Map<string, Tool<any>>();
  /** alias → canonical name (like the real registry's bash → shell). */
  constructor(tools: Tool<any>[], private aliases: Record<string, string> = {}) { for (const t of tools) this.tools.set(t.name, t); }
  register(t: Tool<any>): void { this.tools.set(t.name, t); }
  list(): Tool<any>[] { return [...this.tools.values()]; }
  private resolve(name: string): string { return this.aliases[name] ?? name; }
  get(name: string): Tool<any> | undefined { return this.tools.get(this.resolve(name)); }
  has(name: string): boolean { return this.tools.has(this.resolve(name)); }
  isReadOnly(name: string): boolean { return this.get(name)?.isReadOnly ?? false; }
  filterByMode(mode: ToolExecutionMode): Tool<any>[] {
    let tools = this.list();
    if (mode.mode === 'plan') tools = tools.filter(t => t.isReadOnly || t.name === 'present_plan' || t.name.startsWith('todo_'));
    else if (mode.mode === 'subagent') {
      const noRecursion = new Set(['task', 'gather', 'orchestrate', 'fanout', 'present_plan']);
      tools = tools.filter(t => !noRecursion.has(t.name));
    } else tools = tools.filter(t => t.name !== 'present_plan');
    if (mode.allowedTools) tools = tools.filter(t => mode.allowedTools!.includes(t.name));
    if (mode.blockedTools) tools = tools.filter(t => !mode.blockedTools!.includes(t.name));
    return tools;
  }
  getSchemas(mode: ToolExecutionMode): ToolSchema[] {
    return this.filterByMode(mode).map(t => t.schema()).sort((a, b) => a.function.name.localeCompare(b.function.name));
  }
  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const t = this.get(name);
    if (!t) return { content: `[ERROR] Unknown tool: ${name}`, isError: true };
    try {
      return await t.execute(t.argsSchema.parse(args ?? {}), ctx);
    } catch (e: any) {
      return { content: `[TOOL_ERROR] ${name} failed: ${e?.message ?? e}`, isError: true };
    }
  }
}

/** One scripted model turn: optional text and/or tool calls. */
export interface FakeTurn {
  text?: string;
  calls?: Array<{ name: string; args?: Record<string, unknown>; id?: string }>;
}

export const FAKE_MODEL: ModelInfo = {
  id: 'fake-model',
  contextWindow: 200_000,
  maxOutput: 4096,
  inputCostPerMillion: 0,
  outputCostPerMillion: 0,
  supportsToolCalls: true,
  supportsStreaming: true,
};

/** A provider that replays a script; records every request it receives. */
export class FakeProvider {
  name = 'fake';
  isLocal = true;
  requests: CompletionRequest[] = [];
  constructor(private script: (req: CompletionRequest, callIndex: number) => FakeTurn) {}
  async isAvailable(): Promise<boolean> { return true; }
  async listModels(): Promise<ModelInfo[]> { return [FAKE_MODEL]; }
  async *complete(req: CompletionRequest): AsyncGenerator<StreamEvent> {
    const idx = this.requests.length;
    // Snapshot the messages: the loop keeps mutating its arrays after dispatch.
    this.requests.push({ ...req, messages: req.messages.map(m => ({ ...m })) });
    const turn = this.script(req, idx);
    if (turn.text) yield { type: 'text_delta', delta: turn.text };
    for (let i = 0; i < (turn.calls ?? []).length; i++) {
      const c = turn.calls![i]!;
      yield {
        type: 'tool_call_delta',
        toolCallIndex: i,
        toolCallId: c.id ?? `call_${idx}_${i}`,
        toolName: c.name,
        toolArgsDelta: JSON.stringify(c.args ?? {}),
      };
    }
    yield { type: 'usage', usage: { input: 100, output: 20 } };
    yield { type: 'done' };
  }
}

/** A router that always routes to `provider`. */
export function fakeRouter(provider: FakeProvider): any {
  return {
    route: () => ({ provider, model: FAKE_MODEL.id, modelInfo: FAKE_MODEL }),
    resolveModel: () => null,
  };
}

/** A permissions stand-in that allows everything. */
export const allowAllPermissions: any = {
  evaluate: () => 'allow',
  rememberDecision: () => {},
};

/** DEFAULT_CONFIG with the slow / networked / disk-heavy extras turned off for tests. */
export function testConfig(overrides: Record<string, unknown> = {}): QodexConfig {
  const cfg: any = structuredClone(DEFAULT_CONFIG);
  cfg.context = { liveSync: false, autoRetrieve: false, dependencyMap: false };
  cfg.tools = { autoProfile: false };
  cfg.skills = { autoInject: false, suggestUninstalled: false };
  cfg.discipline = { verifyBaseline: false };
  cfg.verify = { auto: false };
  cfg.subagents = { mode: 'sequential' };
  cfg.compaction = { enabled: false };
  for (const [k, v] of Object.entries(overrides)) {
    cfg[k] = (v && typeof v === 'object' && !Array.isArray(v) && cfg[k] && typeof cfg[k] === 'object')
      ? { ...cfg[k], ...(v as object) }
      : v;
  }
  return cfg as QodexConfig;
}

/** Tool messages (role 'tool') of a recorded request, by tool name. */
export function toolResultsIn(req: CompletionRequest | undefined, name?: string): string[] {
  if (!req) return [];
  return req.messages
    .filter(m => m.role === 'tool' && (!name || m.name === name))
    .map(m => String(m.content ?? ''));
}

/** Names of the tools shipped with a recorded request. */
export function toolNamesIn(req: CompletionRequest | undefined): string[] {
  return (req?.tools ?? []).map(t => t.function.name).sort();
}
