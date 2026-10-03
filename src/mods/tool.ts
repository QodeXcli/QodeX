/**
 * A tool a mod registered with $.tool.register: `mod__<plugin>__<name>` in the
 * ToolRegistry. The mod answers its calls in a tool.call hook — the agent loop fires
 * tool.call around every call, and a mod tool that no hook answered falls through to
 * execute() here, which returns an error result.
 *
 * inputSchema is a raw JSON schema (shipped to the model as is, arguments passed through
 * unvalidated) or a zod schema (its JSON form is shipped; arguments are parsed by it).
 */
import { z } from 'zod';
import { Tool, type ToolResult } from '../tools/base.js';
import type { ToolSchema } from '../llm/types.js';

export const MOD_TOOL_PREFIX = 'mod__';

export function modToolName(plugin: string, name: string): string {
  return `${MOD_TOOL_PREFIX}${plugin}__${name}`;
}

export function isModToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(MOD_TOOL_PREFIX);
}

/** The mod a tool name belongs to (undefined for other tools). */
export function modToolOwner(name: string): string | undefined {
  if (!isModToolName(name)) return undefined;
  const rest = name.slice(MOD_TOOL_PREFIX.length);
  const i = rest.indexOf('__');
  return i > 0 ? rest.slice(0, i) : undefined;
}

function isZod(v: unknown): v is z.ZodTypeAny {
  return !!v && typeof v === 'object' && typeof (v as { safeParse?: unknown }).safeParse === 'function' && '_def' in (v as object);
}

/** A raw JSON schema normalized to an object schema the providers accept. */
function normalizeJsonSchema(raw: Record<string, unknown>): ToolSchema['function']['parameters'] {
  const s = JSON.parse(JSON.stringify(raw ?? {})) as Record<string, unknown>;
  if (s.type !== 'object') return { type: 'object', properties: {}, required: [] } as ToolSchema['function']['parameters'];
  if (!s.properties || typeof s.properties !== 'object') s.properties = {};
  if (!Array.isArray(s.required)) s.required = [];
  return s as ToolSchema['function']['parameters'];
}

export class ModTool extends Tool<Record<string, unknown>> {
  name: string;
  description: string;
  argsSchema: z.ZodType<Record<string, unknown>>;
  isReadOnly: boolean;
  isDestructive = false;
  readonly plugin: string;
  private readonly jsonSchema: ToolSchema['function']['parameters'] | null;

  constructor(plugin: string, spec: { name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean }) {
    super();
    this.plugin = plugin;
    this.name = modToolName(plugin, spec.name);
    this.description = String(spec.description ?? '').trim();
    this.isReadOnly = spec.readOnly === true;
    if (isZod(spec.inputSchema)) {
      this.argsSchema = spec.inputSchema as unknown as z.ZodType<Record<string, unknown>>;
      this.jsonSchema = null;
    } else {
      this.argsSchema = z.object({}).passthrough() as unknown as z.ZodType<Record<string, unknown>>;
      this.jsonSchema = normalizeJsonSchema(spec.inputSchema ?? {});
    }
  }

  schema(): ToolSchema {
    if (!this.jsonSchema) return super.schema();
    return { type: 'function', function: { name: this.name, description: this.description, parameters: this.jsonSchema } };
  }

  async execute(): Promise<ToolResult> {
    return {
      content: `[MOD_TOOL_UNANSWERED] ${this.name} belongs to mod "${this.plugin}", and no tool.call hook of it answered this call (is the mod loaded and enabled?).`,
      isError: true,
    };
  }
}
