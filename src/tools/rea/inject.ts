/**
 * `rea_inject` — inject a compiled Frida agent bundle into a process and
 * capture what it sends back for a bounded window.
 *
 * Only run against a process the user owns or has explicit permission to
 * instrument. The injection is bounded: the agent is detached when the
 * capture window ends, and the call returns the collected telemetry.
 * For an interactive, long-lived session use `qodex rea inject` instead.
 */
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { ProcessInjector, type DeviceKind } from '../../rea/injector.js';

const Args = z.object({
  target: z
    .string()
    .min(1)
    .describe('Process name (e.g. "Safari") or pid (e.g. "1234").'),
  agentBundle: z.string().min(1).describe('Path to a compiled agent bundle (frida-compile output, .js).'),
  spawn: z.boolean().optional().describe('Spawn the program suspended, instrument, then resume.'),
  device: z.enum(['local', 'usb', 'remote']).optional().describe('Frida device to use.'),
  durationMs: z
    .number()
    .int()
    .min(500)
    .max(120_000)
    .optional()
    .describe('How long to keep the agent attached and collect telemetry (ms).'),
});

export class ReaInjectTool extends Tool<z.infer<typeof Args>> {
  name = 'rea_inject';
  description =
    'Inject a compiled Frida agent bundle into a process and capture its telemetry for a bounded window, then detach. ' +
    'Only for processes the user owns or has explicit permission to instrument. ' +
    'Returns the telemetry the agent sent back (keys, plaintext buffers, logs). ' +
    'For a long-lived interactive session, use `qodex rea inject`.';
  isReadOnly = false;
  isDestructive = true;
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, _ctx: ToolContext): Promise<ToolResult> {
    const injector = new ProcessInjector();
    try {
      const exports = await injector.inject({
        deviceType: (args.device ?? 'local') as DeviceKind,
        targetProcess: /^\d+$/.test(args.target) ? Number(args.target) : args.target,
        spawnMode: args.spawn ?? false,
        agentBundlePath: args.agentBundle,
      });
      await new Promise((resolve) => setTimeout(resolve, args.durationMs ?? 5000));
      const telemetry = injector.telemetry.map((entry) => ({
        payload: entry.payload,
        dataLength: entry.dataLength,
        receivedAt: entry.receivedAt.toISOString(),
      }));
      return {
        content: JSON.stringify(
          {
            target: args.target,
            agentExports: Object.keys(exports),
            telemetryEntries: telemetry.length,
            telemetry,
          },
          null,
          2,
        ),
      };
    } catch (e: any) {
      return { content: `rea_inject failed: ${e?.message ?? e}`, isError: true };
    } finally {
      await injector.detach();
    }
  }
}
