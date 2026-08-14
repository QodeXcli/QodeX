/**
 * A user-plugin tool is a named shell template — no eval, no require().
 * Args declared in plugin.json are substituted as quoted values into {{name}}.
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import { Tool, type ToolContext, type ToolResult } from '../tools/base.js';
import { childEnv } from '../secrets/sanitize.js';

export interface UserToolSpec {
  name: string;
  description: string;
  command: string;
  args?: string[];
  destructive?: boolean;
  timeoutSeconds?: number;
  plugin: string;
}

const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;

export function isSafeToolName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Substitute {{arg}} tokens. Unknown tokens are left as-is so the command fails loudly. */
export function fillTemplate(command: string, values: Record<string, string>): string {
  return command.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) return `{{${key}}}`;
    return shellQuote(v);
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function argsSchemaFor(spec: UserToolSpec): z.ZodType<Record<string, string>> {
  const shape: Record<string, z.ZodType<string>> = {};
  for (const a of spec.args ?? []) {
    shape[a] = z.string().describe(a);
  }
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, string>>;
}

export class UserPluginTool extends Tool<Record<string, string>> {
  name: string;
  description: string;
  isReadOnly: boolean;
  isDestructive: boolean;
  argsSchema: z.ZodType<Record<string, string>>;
  private spec: UserToolSpec;

  constructor(spec: UserToolSpec) {
    super();
    this.spec = spec;
    this.name = spec.name;
    this.description = `[plugin:${spec.plugin}] ${spec.description}`;
    this.isReadOnly = !spec.destructive;
    this.isDestructive = !!spec.destructive;
    this.argsSchema = argsSchemaFor(spec);
  }

  async execute(args: Record<string, string>, ctx: ToolContext): Promise<ToolResult> {
    const cmd = fillTemplate(this.spec.command, args);
    const timeoutMs = Math.min(600_000, Math.max(1_000, (this.spec.timeoutSeconds ?? 120) * 1000));
    return new Promise(resolve => {
      const proc = spawn(cmd, {
        cwd: ctx.cwd,
        env: childEnv(),
        shell: true,
        signal: ctx.signal,
      });
      let out = '';
      let err = '';
      const cap = 60_000;
      proc.stdout?.on('data', (d: Buffer) => {
        const t = d.toString('utf-8');
        out = (out + t).slice(-cap);
        for (const line of t.split('\n')) if (line) ctx.emit({ type: 'shell-stdout', line });
      });
      proc.stderr?.on('data', (d: Buffer) => {
        const t = d.toString('utf-8');
        err = (err + t).slice(-cap);
        for (const line of t.split('\n')) if (line) ctx.emit({ type: 'shell-stderr', line });
      });
      const timer = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* */ } }, timeoutMs);
      proc.on('close', code => {
        clearTimeout(timer);
        const body = [out.trim(), err.trim()].filter(Boolean).join('\n');
        if (code === 0) {
          resolve({ content: body || `(${this.name} exited 0)` });
        } else {
          resolve({ content: `[PLUGIN_TOOL_FAILED] ${this.name} exited ${code}\n${body}`, isError: true });
        }
      });
      proc.on('error', e => {
        clearTimeout(timer);
        resolve({ content: `[PLUGIN_TOOL_FAILED] ${this.name}: ${e.message}`, isError: true });
      });
    });
  }
}
