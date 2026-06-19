/**
 * `orchestrate` tool — run the Multi-Agent Orchestration Engine on a goal.
 *
 * This is the user-facing entry point for the Triad. Given a goal, it:
 *   1. Decomposes it into a task DAG (the Orchestrator / tech-lead role).
 *   2. Executes the DAG with parallel workers + QA review + staged commits.
 *   3. Reports committed/failed/blocked tasks, conflicts, and token savings.
 *
 * It requires the sub-agent runner to be active (subagents enabled), since
 * workers and the planner run as sub-agents. If subagents are off, it tells the
 * user how to enable them rather than silently failing.
 *
 * Design tokens are auto-extracted from the project (tailwind config / CSS
 * custom properties) so component workers match the existing system.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getSubAgentRunner } from './task.js';

const Args = z.object({
  goal: z.string().describe('The high-level goal to decompose and build in parallel (e.g. "add a CCTV pricing page with a comparison table and a contact form").'),
  max_concurrency: z.number().int().min(1).max(8).optional().describe('Max parallel workers (default 3).'),
  dry_run: z.boolean().optional().describe('If true, only decompose and show the DAG; do not execute.'),
});

export class OrchestrateTool extends Tool<z.infer<typeof Args>> {
  name = 'orchestrate';
  description =
    'Decompose a goal into a DAG of isolated tasks and build them in PARALLEL with specialized worker sub-agents, ' +
    'automated QA peer-review, and staged conflict-free commits. Use for multi-file features that split cleanly ' +
    '(schema + backend + components + wiring). Each worker gets a minimal sliced context (token-optimized). ' +
    'Requires sub-agents to be enabled.';
  isReadOnly = false;
  isDestructive = true; // commits files to disk after QA
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, ctx: ToolContext): Promise<ToolResult> {
    if (!getSubAgentRunner()) {
      return {
        content: 'Orchestration needs sub-agents enabled. Turn them on with `/subagents parallel` (or `sequential`), then retry.',
        isError: true,
      };
    }

    const { Orchestrator } = await import('../../orchestration/engine.js');
    const designTokens = await extractDesignTokens(ctx.cwd);

    const events: string[] = [];
    const engine = new Orchestrator({
      cwd: ctx.cwd,
      maxConcurrency: args.max_concurrency ?? 3,
      maxAttempts: 2,
      designTokens,
      qaHooks: buildQaHooks(ctx.cwd),
      onEvent: (ev) => {
        const line = formatEvent(ev);
        if (line) { events.push(line); ctx.emit({ type: 'progress', message: line }); }
      },
    });

    // 1. Decompose.
    ctx.emit({ type: 'progress', message: `Orchestrator: decomposing goal…` });
    let graph;
    try {
      graph = await engine.decompose(args.goal, ctx.signal);
    } catch (e: any) {
      return { content: `Decomposition failed: ${e.message}`, isError: true };
    }

    const planLines = [`# Task DAG (${graph.nodes.size} nodes)`];
    for (const n of graph.nodes.values()) {
      const deps = n.dependsOn.length ? ` ← [${n.dependsOn.join(', ')}]` : '';
      planLines.push(`  ${n.id} (${n.kind})${deps}: ${n.title}  → ${n.targetFiles.join(', ')}`);
    }

    if (args.dry_run) {
      return { content: planLines.join('\n') + '\n\n(dry run — not executed)' };
    }

    // 2. Execute.
    const report = await engine.execute(graph, ctx.signal);

    // 3. Report.
    const out = [...planLines, ''];
    out.push(`## Execution report`);
    out.push(`  ✓ committed: ${report.committed.length}  [${report.committed.join(', ')}]`);
    if (report.failed.length) out.push(`  ✗ failed: ${report.failed.length}  [${report.failed.join(', ')}]`);
    if (report.blocked.length) out.push(`  ⊘ blocked: ${report.blocked.length}  [${report.blocked.join(', ')}]`);
    out.push(`  ⧉ tool calls: ${report.totalToolCalls}`);
    out.push(`  ⤓ tokens saved vs naive context: ~${report.tokensSavedEstimate.toLocaleString()}`);
    out.push(`  ⏱ duration: ${(report.durationMs / 1000).toFixed(1)}s`);
    if (report.conflicts.length) {
      out.push(`  ⚠ conflicts:`);
      for (const c of report.conflicts) out.push(`     ${c.kind} on ${c.file} (${c.taskA} vs ${c.taskB}) → ${c.resolution}`);
    }

    const ok = report.failed.length === 0 && report.blocked.length === 0;
    return {
      content: out.join('\n'),
      isError: !ok,
      metadata: { committed: report.committed.length, failed: report.failed.length, tokensSaved: report.tokensSavedEstimate },
    };
  }
}

function formatEvent(ev: any): string | null {
  switch (ev.type) {
    case 'node-start': return `  ▶ ${ev.id} started${ev.role ? ` [${ev.role}]` : ''}`;
    case 'node-review': return `  ${ev.passed ? '✓' : '✗'} ${ev.id} QA ${ev.passed ? 'passed' : 'failed'}`;
    case 'node-commit': return `  ● ${ev.id} committed`;
    case 'node-retry': return `  ↻ ${ev.id} retry ${ev.attempt}: ${ev.blockers.slice(0, 2).join('; ')}`;
    case 'node-failed': return `  ✗ ${ev.id} failed: ${ev.error}`;
    case 'node-blocked': return `  ⊘ ${ev.id} blocked by ${ev.cause}`;
    case 'conflict': return `  ⚠ conflict on ${ev.record.file}`;
    default: return null;
  }
}

/** Extract design tokens from tailwind config + CSS :root custom properties. */
async function extractDesignTokens(cwd: string): Promise<string | undefined> {
  const pieces: string[] = [];
  // CSS custom properties from common entry files.
  const cssCandidates = ['src/index.css', 'src/App.css', 'src/styles/globals.css', 'styles/globals.css', 'app/globals.css'];
  for (const rel of cssCandidates) {
    try {
      const content = await fs.readFile(path.join(cwd, rel), 'utf-8');
      const rootBlock = content.match(/:root\s*\{([\s\S]*?)\}/);
      if (rootBlock) {
        const vars = rootBlock[1]!.split('\n').map(l => l.trim()).filter(l => l.startsWith('--')).join('\n');
        if (vars) pieces.push(`/* ${rel} :root */\n${vars}`);
      }
    } catch { /* missing */ }
  }
  // Tailwind theme.extend.colors (just the snippet, not the whole config).
  for (const rel of ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs']) {
    try {
      const content = await fs.readFile(path.join(cwd, rel), 'utf-8');
      const colors = content.match(/colors\s*:\s*\{[\s\S]*?\n\s{4,6}\}/);
      if (colors) pieces.push(`/* ${rel} colors */\n${colors[0]}`);
      break;
    } catch { /* missing */ }
  }
  return pieces.length ? pieces.join('\n\n') : undefined;
}

/** Build QA hooks: a lightweight design audit over staged content (no disk I/O). */
function buildQaHooks(_cwd: string) {
  return {
    designAudit: async (files: Array<{ path: string; content: string }>) => {
      const issues: Array<{ severity: 'high' | 'medium' | 'low'; message: string }> = [];
      for (const f of files) {
        if (!/\.(tsx|jsx|css)$/.test(f.path)) continue;
        const lines = f.content.split('\n');
        let hasDark = /\bdark:/.test(f.content);
        let usesLightBg = /\b(bg-white|bg-gray-50|bg-gray-100)\b/.test(f.content);
        lines.forEach((line, i) => {
          // raw hex in className
          if (/className=["'][^"']*#[0-9a-fA-F]{3,6}/.test(line)) {
            issues.push({ severity: 'medium', message: `${f.path}:${i + 1} raw hex in className — use a token` });
          }
          // <img> without alt
          if (/<img\b/.test(line) && !/\balt=/.test(line)) {
            issues.push({ severity: 'high', message: `${f.path}:${i + 1} <img> missing alt (a11y)` });
          }
        });
        // dark-mode coverage: a component using light bg with no dark: variants
        if (usesLightBg && !hasDark) {
          issues.push({ severity: 'low', message: `${f.path} uses light backgrounds with no dark: variants` });
        }
      }
      return issues;
    },
  };
}
