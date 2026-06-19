/**
 * Eval scoring — the pure, deterministic core of the QodeX eval harness.
 *
 * WHY THIS MATTERS (meta-multiplier): every other improvement (constrained decoding,
 * retrieval, diagnostics, a model swap, a prompt edit) is a bet. Without a way to MEASURE
 * task success you're tuning by vibes — a change that helps one task can silently break
 * five others. This module turns "did the agent actually do the job" into a number:
 * run a fixed set of small tasks headless, check the resulting filesystem / exit codes,
 * and report pass-rate + iterations + tokens + cost. Then you tune against the score.
 *
 * Kept free of I/O so it's unit-tested like the rest of the codebase; the runner
 * (`eval/run.mjs`) does the spawning and feeds observed outcomes in here.
 */

export interface FileContentCheck {
  path: string;
  /** Substring that must appear in the file. */
  contains?: string;
  /** Regex (source string) the file content must match. */
  matches?: string;
}

export interface CommandCheck {
  command: string;
  /** Pass when the command exits 0. Default true. */
  expectExitZero?: boolean;
}

export interface EvalCheck {
  /** These files must exist after the run. */
  filesExist?: string[];
  /** Per-file content assertions. */
  fileChecks?: FileContentCheck[];
  /** A verification command run in the task workspace (e.g. "npm test"). */
  command?: CommandCheck;
}

export interface EvalTask {
  id: string;
  description?: string;
  prompt: string;
  /** Files written into the workspace before the run. */
  setup?: { files?: Record<string, string> };
  check: EvalCheck;
  maxIterations?: number;
}

/** What the runner observed about the workspace AFTER the agent finished. */
export interface Outcome {
  /** Which paths (relative to the workspace) actually exist now. */
  existingFiles: string[];
  /** Content of files referenced by fileChecks (path → content). Missing = absent. */
  fileContents: Record<string, string>;
  /** Exit code of the check command, if one was run. */
  commandExitCode?: number | null;
  /** Fatal harness/agent error (e.g. no model available). */
  error?: string;
}

export interface CheckResult {
  passed: boolean;
  reasons: string[];
}

/** Evaluate a task's checks against an observed outcome. Pure. */
export function evaluateChecks(check: EvalCheck, outcome: Outcome): CheckResult {
  const reasons: string[] = [];
  const existing = new Set(outcome.existingFiles);

  if (outcome.error) {
    reasons.push(`run error: ${outcome.error}`);
  }

  for (const p of check.filesExist ?? []) {
    if (!existing.has(p)) reasons.push(`expected file missing: ${p}`);
  }

  for (const fc of check.fileChecks ?? []) {
    const content = outcome.fileContents[fc.path];
    if (content == null) {
      reasons.push(`file not found for content check: ${fc.path}`);
      continue;
    }
    if (fc.contains != null && !content.includes(fc.contains)) {
      reasons.push(`${fc.path} does not contain "${fc.contains}"`);
    }
    if (fc.matches != null) {
      let re: RegExp | null = null;
      try { re = new RegExp(fc.matches); } catch { reasons.push(`invalid regex for ${fc.path}: ${fc.matches}`); }
      if (re && !re.test(content)) reasons.push(`${fc.path} does not match /${fc.matches}/`);
    }
  }

  if (check.command) {
    const expectZero = check.command.expectExitZero ?? true;
    const code = outcome.commandExitCode;
    if (expectZero && code !== 0) reasons.push(`command "${check.command.command}" exited ${code ?? 'null'} (expected 0)`);
    if (!expectZero && code === 0) reasons.push(`command "${check.command.command}" exited 0 (expected non-zero)`);
  }

  return { passed: reasons.length === 0, reasons };
}

export interface TaskRunResult {
  id: string;
  passed: boolean;
  reasons: string[];
  iterations: number;
  toolCalls: number;
  costUsd: number;
  wallMs: number;
  error?: string;
}

export interface EvalSummary {
  total: number;
  passed: number;
  passRate: number;
  avgIterations: number;
  avgToolCalls: number;
  totalCostUsd: number;
  avgWallMs: number;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function summarize(results: TaskRunResult[]): EvalSummary {
  const passed = results.filter(r => r.passed).length;
  return {
    total: results.length,
    passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    avgIterations: avg(results.map(r => r.iterations)),
    avgToolCalls: avg(results.map(r => r.toolCalls)),
    totalCostUsd: results.reduce((a, r) => a + r.costUsd, 0),
    avgWallMs: avg(results.map(r => r.wallMs)),
  };
}

/** Render a Markdown report. Pure — the runner writes it to disk. */
export function formatReport(results: TaskRunResult[], summary: EvalSummary, meta: { model?: string; when?: string } = {}): string {
  const lines: string[] = [];
  lines.push('# QodeX Eval Report');
  if (meta.when) lines.push(`Run: ${meta.when}`);
  if (meta.model) lines.push(`Model: ${meta.model}`);
  lines.push('');
  lines.push(`**${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(0)}%)**`);
  lines.push('');
  lines.push(`- avg iterations: ${summary.avgIterations.toFixed(1)}`);
  lines.push(`- avg tool calls: ${summary.avgToolCalls.toFixed(1)}`);
  lines.push(`- avg wall time: ${(summary.avgWallMs / 1000).toFixed(1)}s`);
  lines.push(`- total cost: $${summary.totalCostUsd.toFixed(4)}`);
  lines.push('');
  lines.push('| Task | Result | Iters | Tools | Time | Notes |');
  lines.push('|------|--------|-------|-------|------|-------|');
  for (const r of results) {
    const mark = r.passed ? '✅ pass' : '❌ fail';
    const notes = r.passed ? '' : r.reasons.slice(0, 2).join('; ').replace(/\|/g, '\\|');
    lines.push(`| ${r.id} | ${mark} | ${r.iterations} | ${r.toolCalls} | ${(r.wallMs / 1000).toFixed(1)}s | ${notes} |`);
  }
  lines.push('');
  return lines.join('\n');
}
