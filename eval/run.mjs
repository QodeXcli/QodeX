#!/usr/bin/env node
/**
 * QodeX eval harness — runs a fixed set of small coding tasks against the REAL agent
 * (headless), checks the resulting filesystem / exit codes, and writes a scored report.
 *
 * Usage:
 *   npm run eval                 # build, then run every task in eval/tasks/
 *   node eval/run.mjs <id...>    # run only the named task ids
 *   EVAL_MODEL=qwen/... node eval/run.mjs   # override the model
 *
 * It deliberately uses the same `qx --print` entrypoint a user would, in a throwaway
 * temp workspace per task, so the score reflects the whole stack (prompt → routing →
 * constrained decoding → retrieval → tools), not a mock. Requires a model to be
 * available (local Ollama/LM Studio or a cloud key); with none, every task fails with
 * a clear "no model" reason rather than crashing.
 *
 * Pure scoring/report logic lives in src/eval/score.ts (compiled to dist) and is
 * unit-tested separately — this file only does I/O and orchestration.
 */

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(repoRoot, 'bin', 'qodex.mjs');
const tasksDir = path.join(repoRoot, 'eval', 'tasks');

const scoreModPath = path.join(repoRoot, 'dist', 'eval', 'score.js');
if (!fsSync.existsSync(scoreModPath)) {
  console.error('dist/eval/score.js not found — run `npm run build` first (or use `npm run eval`).');
  process.exit(1);
}
const { evaluateChecks, summarize, formatReport } = await import(scoreModPath);

const PER_TASK_TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 300_000);
const model = process.env.EVAL_MODEL;

async function loadTasks(filter) {
  const files = (await fs.readdir(tasksDir)).filter(f => f.endsWith('.json')).sort();
  const tasks = [];
  for (const f of files) {
    const task = JSON.parse(await fs.readFile(path.join(tasksDir, f), 'utf-8'));
    if (!filter.length || filter.includes(task.id)) tasks.push(task);
  }
  return tasks;
}

function runAgent(prompt, cwd) {
  return new Promise((resolve) => {
    const args = ['--print', prompt, '--yes', '--json'];
    if (model) args.push('--model', model);
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, QODEX_SKIP_SETUP: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, PER_TASK_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message }); });
  });
}

/** Parse NDJSON agent events to recover iteration/tool/cost telemetry + any error. */
function parseAgentEvents(stdout) {
  let iterations = 0, toolCalls = 0, costUsd = 0, error;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (ev.type === 'iteration_start' && typeof ev.iteration === 'number') iterations = Math.max(iterations, ev.iteration);
    if (ev.type === 'tool_call_start') toolCalls += 1;
    if (ev.type === 'budget_update' && typeof ev.lastCostUsd === 'number') costUsd += ev.lastCostUsd;
    if (ev.type === 'error' && ev.message) error = ev.message;
  }
  return { iterations, toolCalls, costUsd, error };
}

async function observeOutcome(task, cwd, runError) {
  const existingFiles = [];
  const fileContents = {};
  for (const p of task.check.filesExist ?? []) {
    if (fsSync.existsSync(path.join(cwd, p))) existingFiles.push(p);
  }
  for (const fc of task.check.fileChecks ?? []) {
    const abs = path.join(cwd, fc.path);
    if (fsSync.existsSync(abs)) {
      if (!existingFiles.includes(fc.path)) existingFiles.push(fc.path);
      fileContents[fc.path] = await fs.readFile(abs, 'utf-8');
    }
  }
  let commandExitCode;
  if (task.check.command) {
    const res = spawnSync(task.check.command.command, { cwd, shell: true, timeout: 60_000, env: { ...process.env, FORCE_COLOR: '0' } });
    commandExitCode = res.status;
  }
  return { existingFiles, fileContents, commandExitCode, error: runError };
}

async function runTask(task) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `qodex-eval-${task.id}-`));
  try {
    for (const [rel, content] of Object.entries(task.setup?.files ?? {})) {
      const abs = path.join(work, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
    }

    // A TypeScript task needs tsc reachable via `npx --no-install tsc` (what both the
    // auto-verify gate and the check command run). Real projects have it in node_modules;
    // our throwaway workspace doesn't, so symlink this repo's node_modules in. Contained
    // to the harness — product code is untouched.
    if (fsSync.existsSync(path.join(work, 'tsconfig.json'))) {
      try {
        await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(work, 'node_modules'), 'dir');
      } catch { /* best-effort */ }
    }

    const started = Date.now();
    const run = await runAgent(task.prompt, work);
    const wallMs = Date.now() - started;
    const tele = parseAgentEvents(run.stdout);

    const outcome = await observeOutcome(task, work, tele.error);
    const verdict = evaluateChecks(task.check, outcome);

    process.stdout.write(`  ${verdict.passed ? '✅' : '❌'} ${task.id}  (${tele.iterations} iters, ${tele.toolCalls} tools, ${(wallMs / 1000).toFixed(1)}s)\n`);
    if (!verdict.passed) for (const r of verdict.reasons) process.stdout.write(`       · ${r}\n`);

    return {
      id: task.id,
      passed: verdict.passed,
      reasons: verdict.reasons,
      iterations: tele.iterations,
      toolCalls: tele.toolCalls,
      costUsd: tele.costUsd,
      wallMs,
      error: tele.error,
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const filter = process.argv.slice(2);
  const tasks = await loadTasks(filter);
  if (tasks.length === 0) {
    console.error(`No tasks found in ${tasksDir}${filter.length ? ` matching ${filter.join(', ')}` : ''}.`);
    process.exit(1);
  }

  console.log(`Running ${tasks.length} eval task(s)${model ? ` with model ${model}` : ''}…\n`);
  const results = [];
  for (const task of tasks) {
    results.push(await runTask(task));
  }

  const summary = summarize(results);
  const when = new Date().toISOString();
  const report = formatReport(results, summary, { model: model ?? '(default)', when });

  const reportPath = path.join(repoRoot, 'eval', 'report.md');
  await fs.writeFile(reportPath, report, 'utf-8');

  console.log(`\n${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(0)}%). Report: ${path.relative(repoRoot, reportPath)}`);
}

main().catch(err => { console.error('Eval harness error:', err); process.exit(1); });
