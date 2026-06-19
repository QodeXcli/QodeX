import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getSubAgentRunner } from './task.js';
import { logger } from '../../utils/logger.js';

/**
 * `gather` — parallel read-only reconnaissance.
 *
 * For a big task, the model dispatches several READ-ONLY "scout" sub-agents at once,
 * each collecting one slice of the data/context the decision needs (e.g. "how is auth
 * used across the codebase", "what tests cover it", "what does the git history say",
 * "what do the deps look like"). Their findings are consolidated and returned so the
 * PARENT agent can make the best-informed decision. The scouts gather; the parent decides.
 *
 * Scouts run with role 'scout' → restricted to read-only tools (no file writes, no
 * mutating shell). So `gather` itself is read-only and safe to run without prompts.
 *
 * Parallelism note: workers are dispatched concurrently, but real speedup depends on the
 * model endpoint serving concurrent requests (Ollama with OLLAMA_NUM_PARALLEL, or multiple
 * endpoints). A single LM Studio instance will largely serialize them — the win there is
 * *better, isolated, focused gathering + consolidation*, not wall-clock speed.
 */

const Probe = z.object({
  focus: z.string().min(1).describe('One specific thing to investigate/collect, e.g. "every call site of the auth middleware and how it is configured".'),
  hint: z.string().optional().describe('Optional pointer to where to look (a path, module, URL, or search term) to focus the scout.'),
});

const GatherArgs = z.object({
  probes: z.array(Probe).min(1).max(8).describe('The independent data-collection tasks to run in parallel (1-8). Make each focused and self-contained.'),
  max_concurrency: z.number().int().min(1).max(8).optional().describe('Max scouts running at once. Default 3.'),
  max_iterations_each: z.number().int().min(1).max(15).optional().describe('Tool-call cap per scout. Default 6 — gathering should be quick.'),
});

/** Bounded-concurrency map: runs fn over items with at most `limit` in flight, preserving order. */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i]!, i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/** Build the read-only scout prompt for one probe. Pure → testable. */
export function buildScoutPrompt(focus: string, hint?: string): string {
  return [
    'You are a READ-ONLY reconnaissance scout. Your ONLY job is to gather facts and report them.',
    'You have read-only tools only — do NOT attempt to modify files or run mutating commands.',
    'Investigate strictly the focus below, then report concise, concrete findings as terse bullets,',
    'ending with a one-line "BOTTOM LINE:". Include specifics (paths, names, numbers); no preamble.',
    '',
    `FOCUS: ${focus}`,
    hint ? `WHERE TO LOOK: ${hint}` : '',
    '',
    'Report only what you actually found. If something is undetermined, say so — do not guess.',
  ].filter(Boolean).join('\n');
}

/** Consolidate scout outputs into one briefing for the parent to decide on. Pure → testable. */
export function consolidateFindings(
  parts: Array<{ focus: string; ok: boolean; findings: string; error?: string }>,
): string {
  const lines: string[] = [];
  lines.push(`=== Gathered intelligence (${parts.length} scout${parts.length === 1 ? '' : 's'}) ===`);
  parts.forEach((p, i) => {
    lines.push('');
    lines.push(`[${i + 1}] ${p.focus}`);
    if (p.ok) {
      lines.push((p.findings || '').trim() || '(no findings reported)');
    } else {
      lines.push(`(scout failed: ${p.error ?? 'unknown'})`);
    }
  });
  lines.push('');
  lines.push('--- Now decide using the findings above. Weigh them; flag any gaps or conflicts before committing to an approach. ---');
  return lines.join('\n');
}

export class GatherTool extends Tool<z.infer<typeof GatherArgs>> {
  name = 'gather';
  description =
    'Dispatch several READ-ONLY scout sub-agents in parallel to collect the data/context a big decision needs, ' +
    'then get their findings consolidated into one briefing so YOU can decide. Use before a large or risky task ' +
    '(refactor, migration, architecture choice): split the unknowns into focused probes, gather the facts, then act. ' +
    'Scouts cannot modify anything. Returns consolidated findings — the decision is still yours.';
  isReadOnly = true;          // scouts are read-only; gathering never mutates
  isDestructive = false;
  argsSchema = GatherArgs;

  async execute(args: z.infer<typeof GatherArgs>, ctx: ToolContext): Promise<ToolResult> {
    const runner = getSubAgentRunner();
    if (!runner) {
      return {
        content: '[SUBAGENT_DISABLED] gather needs sub-agents enabled. Run `qx setup` and pick a sub-agent mode, ' +
          'or set subagents.mode: sequential in ~/.qodex/config.yaml.',
        isError: true,
      };
    }

    const probes = args.probes;
    const maxConc = args.max_concurrency ?? 3;
    const maxIter = args.max_iterations_each ?? 6;
    ctx.emit({ type: 'progress', message: `Gathering: dispatching ${probes.length} scout(s), up to ${maxConc} at once…` });
    logger.info('gather: dispatching scouts', { count: probes.length, maxConc, maxIter });

    const start = Date.now();
    const results = await runWithConcurrency(probes, maxConc, async (probe, i) => {
      ctx.emit({ type: 'progress', message: `Scout ${i + 1}/${probes.length}: ${probe.focus.slice(0, 60)}` });
      try {
        const r = await runner(buildScoutPrompt(probe.focus, probe.hint), {
          maxIterations: maxIter,
          signal: ctx.signal,
          sessionId: `${ctx.sessionId}/scout-${i}-${Date.now()}`,
          role: 'scout',
        });
        return { focus: probe.focus, ok: r.ok, findings: r.finalText, error: r.error };
      } catch (e: any) {
        return { focus: probe.focus, ok: false, findings: '', error: e?.message ?? String(e) };
      }
    });

    const elapsedSec = Math.round((Date.now() - start) / 1000);
    const okCount = results.filter(r => r.ok).length;
    return {
      content: consolidateFindings(results),
      metadata: { scouts: probes.length, succeeded: okCount, elapsedSec },
    };
  }
}
