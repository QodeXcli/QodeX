/**
 * `fanout` tool — intelligent parallel map/reduce over sub-agents.
 *
 * Where `orchestrate` builds ONE feature by decomposing it into a dependency
 * DAG, `fanout` takes a list of INDEPENDENT work items and processes them in
 * parallel: it partitions the list into balanced, non-overlapping groups (LPT
 * bin-packing, coupling-aware), hands each group to its own isolated sub-agent,
 * runs them concurrently with a bounded pool, and aggregates every sub-agent's
 * summary into a single report.
 *
 * Use it for sweeps and batch work that splits cleanly across items:
 *   - "Audit every directory under src/ for X" (one sub-agent per partition)
 *   - "Fix each of these N findings" (coupled findings stay together)
 *   - "Review these 20 files" / "research this from 5 angles"
 *
 * Requires sub-agents to be enabled (same as `orchestrate`).
 */

import * as os from 'os';
import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getSubAgentRunner } from './task.js';
import { partitionWork, toWorkItems } from '../../orchestration/partition.js';
import { runFanout, type FanoutJob } from '../../orchestration/fanout.js';
import { getActiveConfig } from '../../config/loader.js';

const Args = z.object({
  goal: z.string().min(1).describe(
    'The shared instruction applied to EVERY item. Each sub-agent receives this goal plus its assigned slice of `items`. Be specific and self-contained — sub-agents have no other context.',
  ),
  items: z.array(z.string().min(1)).min(1).describe(
    'The flat work-list to split across parallel sub-agents (file paths, directories, task titles, findings…). Each item is processed exactly once.',
  ),
  item_weights: z.array(z.number()).optional().describe(
    'Optional relative cost per item, SAME order/length as `items` (e.g. line counts, # of findings). Used to balance partitions so no sub-agent gets a disproportionate load. Defaults to equal weight.',
  ),
  item_groups: z.array(z.string()).optional().describe(
    'Optional coupling key per item, SAME order/length as `items`. Items sharing a non-empty key are guaranteed to land in the SAME partition (use when two items must be handled together, e.g. a change and its caller). Empty string = no coupling.',
  ),
  max_concurrency: z.number().int().min(1).max(16).optional().describe(
    'Max sub-agents running at once. Defaults to min(cpu-1, subagents.maxConcurrent, 8).',
  ),
  max_partitions: z.number().int().min(1).max(32).optional().describe(
    'Hard cap on the number of partitions/sub-agents. Default: as many as concurrency allows, one per item at most.',
  ),
  role: z.string().optional().describe('Role for every sub-agent (e.g. "subagent", "vision"). Optional.'),
  model: z.string().optional().describe('Model id override for every sub-agent. Optional.'),
  max_iterations: z.number().int().min(1).max(20).optional().describe('Per-sub-agent tool-call cap. Default 8.'),
});

type FanoutArgs = z.infer<typeof Args>;

export class FanoutTool extends Tool<FanoutArgs> {
  name = 'fanout';
  description =
    'Run a task in PARALLEL across a list of independent items by partitioning them into balanced, non-overlapping groups and dispatching one isolated sub-agent per group (map/reduce). ' +
    'Smart partitioning: weight-balanced (LPT) and coupling-aware (items sharing a group key stay together). ' +
    'Use for sweeps/batch work — audit every dir, fix N findings, review many files. ' +
    'Differs from `orchestrate` (which builds one feature via a dependency DAG). Requires sub-agents enabled.';
  isReadOnly = false;
  isDestructive = true; // sub-agents may run destructive tools
  argsSchema = Args;

  async execute(args: FanoutArgs, ctx: ToolContext): Promise<ToolResult> {
    if (!getSubAgentRunner()) {
      return {
        content: '[SUBAGENT_DISABLED] `fanout` needs sub-agents enabled. Turn them on with `/subagents parallel` (or `sequential`), then retry.',
        isError: true,
      };
    }

    // 1. Partition the work-list.
    const cfg = getActiveConfig();
    const cpuCeiling = Math.max(1, (os.cpus()?.length ?? 4) - 1);
    const configCap = cfg?.subagents?.maxConcurrent ?? 8;
    const concurrency = Math.max(1, Math.min(args.max_concurrency ?? Math.min(cpuCeiling, configCap, 8), 16));

    const workItems = toWorkItems(args.items, args.item_weights, args.item_groups);
    const partitions = partitionWork(workItems, {
      maxPartitions: args.max_partitions,
      concurrencyCeiling: Math.max(concurrency, args.max_partitions ?? concurrency),
    });

    if (partitions.length === 0) {
      return { content: 'fanout: nothing to do (no items).', isError: true };
    }

    ctx.emit({
      type: 'progress',
      message: `fanout: ${args.items.length} item(s) → ${partitions.length} partition(s), up to ${Math.min(concurrency, partitions.length)} parallel`,
    });

    // 2. Build one sub-agent job per partition.
    const jobs: FanoutJob[] = partitions.map((p, i) => {
      const itemList = p.items.map((it) => `- ${it.id}`).join('\n');
      const prompt =
        `${args.goal}\n\n` +
        `You are sub-agent ${i + 1} of ${partitions.length}. Work ONLY on these ${p.items.length} assigned item(s) — do not touch items outside this list (other sub-agents own those):\n` +
        `${itemList}\n\n` +
        `When done, return a CONCISE summary: what you found/changed per item, and flag anything that needs the caller's attention. Your final message is the result — no preamble.`;
      return {
        label: `fanout ${i + 1}/${partitions.length} (${p.items.length} item${p.items.length === 1 ? '' : 's'})`,
        prompt,
        sessionId: `${ctx.sessionId}/fanout-${i + 1}`,
        role: args.role,
        model: args.model,
        maxIterations: args.max_iterations,
      };
    });

    // 3. Run the pool.
    const results = await runFanout(jobs, {
      maxConcurrency: concurrency,
      signal: ctx.signal,
      onEvent: (ev) => {
        if (ev.type === 'job-start') {
          ctx.emit({ type: 'progress', message: `  ▶ ${ev.label} started` });
        } else {
          ctx.emit({ type: 'progress', message: `  ${ev.ok ? '✓' : '✗'} ${ev.label} ${ev.ok ? 'done' : 'FAILED'} (${(ev.elapsedMs / 1000).toFixed(1)}s, ${ev.toolCallsRun} calls)` });
        }
      },
    });

    // 4. Aggregate.
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    const out: string[] = [];
    out.push(`# fanout report — ${results.length} partition(s), ${ok} ok / ${failed} failed`);
    out.push(`items: ${args.items.length} · concurrency: ${Math.min(concurrency, partitions.length)} · total tool calls: ${results.reduce((s, r) => s + r.toolCallsRun, 0)}`);
    out.push('');
    results.forEach((r, i) => {
      const p = partitions[i]!;
      out.push(`## ${r.ok ? '✓' : '✗'} ${r.label} — ${(r.elapsedMs / 1000).toFixed(1)}s${r.modelUsed ? ` · ${r.modelUsed}` : ''}`);
      out.push(`items: ${p.items.map((it) => it.id).join(', ')}`);
      if (r.ok) {
        out.push(r.finalText || '(no summary)');
      } else {
        out.push(`FAILED: ${r.error ?? 'unknown'}`);
        if (r.finalText) out.push(`partial: ${r.finalText}`);
      }
      out.push('');
    });

    return {
      content: out.join('\n').trim(),
      isError: failed > 0,
      metadata: { partitions: results.length, ok, failed, items: args.items.length },
    };
  }
}
