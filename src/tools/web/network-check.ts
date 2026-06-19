import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { runFullDiagnostic, formatDiagnostic } from '../../utils/network-check.js';

const NetworkCheckArgs = z.object({
  scope: z.enum(['public', 'local', 'all']).optional().describe(
    "Which probes to run. 'public' = internet endpoints, 'local' = Ollama/LM Studio, 'all' = both. Default 'all'."
  ),
});

/**
 * `network_check` — probe internet + local backends.
 *
 * Use cases for the model:
 *   - User asks about something requiring web_search; check first if DDG is reachable.
 *   - web_search returned [NO_RESULTS] 2+ times in a row; verify before reporting "no data".
 *   - Local backend went silent mid-session; check whether Ollama/LM Studio crashed.
 *
 * Cheap and read-only — bounded by per-probe timeouts. Always safe to call.
 */
export class NetworkCheckTool extends Tool<z.infer<typeof NetworkCheckArgs>> {
  name = 'network_check';
  description = 'Probe internet connectivity and local backends (Ollama, LM Studio). Use BEFORE retrying a failed web_search to confirm the backend is actually reachable. Returns per-endpoint status + latency. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = NetworkCheckArgs;

  async execute(args: z.infer<typeof NetworkCheckArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const scope = args.scope ?? 'all';
    const diag = await runFullDiagnostic();
    if (scope === 'public') {
      diag.local = [];
    } else if (scope === 'local') {
      diag.public.probes = [];
    }
    return { content: formatDiagnostic(diag) };
  }
}
