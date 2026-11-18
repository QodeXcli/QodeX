/**
 * The model may read a program the user already has on disk.
 * For live work on a running process (hook, inject, bypass), use the rea_* tools.
 */
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { formatReport, inspectPath } from '../../re/inspect.js';

const Args = z.object({
  path: z.string().min(1).describe('Path to an executable, a DLL/dylib, or a Mac .app bundle on this machine.'),
});

export class ReInspectTool extends Tool<z.infer<typeof Args>> {
  name = 're_inspect';
  description = 'Read a local Mac (Mach-O or .app) or Windows (PE) program statically: architecture, linked libraries, a dependency list, section entropy, and printable strings. Secret-shaped strings are omitted. An unknown file is an error, not a guess. For live instrumentation (hook, inject, bypass), use the rea_* tools.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, _ctx: ToolContext): Promise<ToolResult> {
    const report = await inspectPath(args.path);
    const unknown = report.format === 'unknown' && !report.binary;
    return {
      content: formatReport(report),
      isError: unknown || report.notes.includes('file not found'),
      metadata: { format: report.binary?.format ?? report.format },
    };
  }
}
