import { z } from 'zod';
import type { ToolSchema } from '../llm/types.js';
import type { Transaction } from '../filesystem/transaction.js';
import type { PermissionEngine, PermissionDecision } from '../security/permissions.js';

export interface ToolContext {
  cwd: string;
  sessionId: string;
  transaction: Transaction;
  permissions: PermissionEngine;
  askUser: (prompt: string, options?: string[]) => Promise<string>;
  emit: (event: ToolUIEvent) => void;
  signal?: AbortSignal;
  /** Optional auto-snapshot service. Wired by the agent loop when safety.autoSnapshot is enabled. */
  snapshotService?: {
    takeSnapshot: (reason: string, currentTurn: number) => unknown;
  };
  /** Optional git sandbox (isolated branch). Wired by the loop when sandbox is active,
   *  so tools/the model can request an autonomous backtrack. */
  sandbox?: {
    isActive: () => boolean;
    checkpoint: (label: string) => Promise<string | null>;
    backtrack: () => Promise<string | null>;
  };
  /** Current turn number, used for snapshot retention. */
  currentTurn?: number;
}

export type ToolUIEvent =
  | { type: 'diff'; path: string; before: string | null; after: string }
  | { type: 'shell-stdout'; line: string }
  | { type: 'shell-stderr'; line: string }
  | { type: 'progress'; message: string }
  | { type: 'permission-request'; tool: string; operation: string; description?: string };

export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export abstract class Tool<TArgs = unknown> {
  abstract name: string;
  abstract description: string;
  abstract argsSchema: z.ZodType<TArgs>;
  abstract isReadOnly: boolean;
  abstract isDestructive: boolean;

  /** Return the OpenAI-style schema. */
  schema(): ToolSchema {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.zodToJsonSchema(),
      },
    };
  }

  /** Default zod-to-JSON-schema converter, sufficient for our schemas. */
  protected zodToJsonSchema(): ToolSchema['function']['parameters'] {
    const def = (this.argsSchema as any)._def;
    return this.convertZod(def, this.argsSchema);
  }

  private convertZod(def: any, schema: any): any {
    const typeName = def?.typeName;

    if (typeName === 'ZodObject') {
      const shape = def.shape();
      const properties: Record<string, any> = {};
      const required: string[] = [];
      for (const key of Object.keys(shape)) {
        const fieldSchema = shape[key];
        const fieldDef = fieldSchema._def;
        properties[key] = this.convertZod(fieldDef, fieldSchema);
        if (fieldDef.typeName !== 'ZodOptional' && fieldDef.typeName !== 'ZodDefault') {
          required.push(key);
        }
      }
      return { type: 'object', properties, required };
    }
    if (typeName === 'ZodString') {
      return { type: 'string', description: def.description };
    }
    if (typeName === 'ZodNumber') {
      return { type: 'number', description: def.description };
    }
    if (typeName === 'ZodBoolean') {
      return { type: 'boolean', description: def.description };
    }
    if (typeName === 'ZodArray') {
      return {
        type: 'array',
        items: this.convertZod(def.type._def, def.type),
        description: def.description,
      };
    }
    if (typeName === 'ZodEnum') {
      return { type: 'string', enum: def.values, description: def.description };
    }
    if (typeName === 'ZodOptional') {
      return this.convertZod(def.innerType._def, def.innerType);
    }
    if (typeName === 'ZodDefault') {
      const inner = this.convertZod(def.innerType._def, def.innerType);
      return { ...inner, default: def.defaultValue() };
    }
    if (typeName === 'ZodUnion') {
      // Pick first option for simplicity
      return this.convertZod(def.options[0]._def, def.options[0]);
    }
    return { type: 'string', description: schema?.description };
  }

  /**
   * Optional hook to normalize RAW arguments before schema validation. Lets a tool
   * tolerate common model mistakes (e.g. a JSON-string where an array is expected)
   * without loosening its schema (which would corrupt the generated JSON schema the
   * model sees). Default: identity. Override per-tool as needed.
   */
  coerceArgs(raw: unknown): unknown {
    return raw;
  }

  abstract execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
