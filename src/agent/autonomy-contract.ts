/**
 * Guardrailed autonomy contract — the user-facing fuse box for headless runs.
 *
 * `qodex -p "…" --budget-tokens N --budget-usd N --max-wall S --scope src/ --verify "npm test"`
 * fuses primitives that already exist (BudgetTracker, TransactionJournal.rollbackSession,
 * the headless runner) into ONE contract:
 *
 *   - budgets: forwarded into config.budget so the existing stall-aware BudgetTracker
 *     enforces them (see budget.ts — slow ≠ runaway; the wall ceiling fires only on stall).
 *   - scope:   a pre-write gate consulted by Transaction.write()/delete() — edits outside
 *     the prefix never touch disk.
 *   - verify:  a shell command run AFTER the agent finishes; non-zero exit = failure.
 *   - rollback-on-fail: budget-exceeded/stall, an agent error, or a failed verify rolls
 *     back every journaled write of the session, then a RUN REPORT is printed.
 *     Exit code 0 only on verdict GREEN.
 *
 * This module holds the PURE logic (flag parsing, scope check, verify runner, verdict,
 * report building) so it's unit-testable; the thin wiring lives in cli/modes/headless.ts
 * and index.ts. The only state here is the module-global write-scope root, registered by
 * the headless orchestrator for the duration of a contract run.
 *
 * Follow-ups (deliberately out of the MVP):
 *   - scope-gate shell commands too (a `sed -i` outside the scope is not caught; only
 *     journaled writes are);
 *   - rollbackSession restores file contents but leaves the per-txn git commits in
 *     history (tree is clean, log is not);
 *   - `--no-rollback-on-fail` to keep failed work for inspection.
 */

import * as path from 'path';
import { spawnSync } from 'child_process';

export interface AutonomyContract {
  budgetTokens?: number;
  budgetUsd?: number;
  maxWallSec?: number;
  /** Path prefix (absolute or cwd-relative) that journaled writes must stay inside. */
  scopePrefix?: string;
  /** Shell command run after the agent finishes; non-zero exit = failed run. */
  verifyCmd?: string;
  /** Roll back all session writes on failure. Defaults ON when verify or any budget is set. */
  rollbackOnFail: boolean;
}

/** Raw commander opts (camelCased flags). Strings because commander gives us strings. */
export interface ContractFlagOpts {
  budgetTokens?: string | number;
  budgetUsd?: string | number;
  maxWall?: string | number;
  scope?: string;
  verify?: string;
  rollbackOnFail?: boolean;
}

/** Build a contract from CLI flags. Returns null when no contract flag was given, so a
 *  plain `qodex -p` run stays exactly on the existing path. */
export function contractFromFlags(opts: ContractFlagOpts): AutonomyContract | null {
  const num = (v: string | number | undefined): number | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const budgetTokens = num(opts.budgetTokens);
  const budgetUsd = num(opts.budgetUsd);
  const maxWallSec = num(opts.maxWall);
  const scopePrefix = opts.scope?.trim() ? opts.scope.trim() : undefined;
  const verifyCmd = opts.verify?.trim() ? opts.verify.trim() : undefined;

  const hasBudget = budgetTokens !== undefined || budgetUsd !== undefined || maxWallSec !== undefined;
  const anyFlag = hasBudget || scopePrefix !== undefined || verifyCmd !== undefined || opts.rollbackOnFail === true;
  if (!anyFlag) return null;

  return {
    budgetTokens,
    budgetUsd,
    maxWallSec,
    scopePrefix,
    verifyCmd,
    // Default ON when the user asked for a verify step or any budget — a guardrailed
    // run that fails should leave a clean tree unless they explicitly opt out (follow-up).
    rollbackOnFail: opts.rollbackOnFail === true || verifyCmd !== undefined || hasBudget,
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// Scope check

export function resolveScopeRoot(cwd: string, scopePrefix: string): string {
  return path.resolve(cwd, scopePrefix);
}

/** Path-boundary-aware prefix check: `/a/b` contains `/a/b/c` but NOT `/a/bc`. */
export function isPathInScope(scopeRoot: string, filePath: string): boolean {
  const root = path.resolve(scopeRoot);
  const abs = path.resolve(filePath);
  if (abs === root) return true;
  return abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Module-global write-scope root. Registered by the headless orchestrator before a
// contract run and cleared in its finally — Transaction.write()/delete() consult it
// via checkWriteScope() on every journaled write. Null = no scope active (no-op).
let _writeScopeRoot: string | null = null;

export function setWriteScopeRoot(root: string | null): void {
  _writeScopeRoot = root ? path.resolve(root) : null;
}

export function getWriteScopeRoot(): string | null {
  return _writeScopeRoot;
}

/** Returns a denial message when the path is outside the active scope, else null. */
export function checkWriteScope(absPath: string): string | null {
  if (!_writeScopeRoot) return null;
  if (isPathInScope(_writeScopeRoot, absPath)) return null;
  return (
    `[SCOPE_DENIED] ${absPath} is outside the allowed write scope ${_writeScopeRoot} (--scope). ` +
    `Edit refused — work within the scope, or the user must rerun without --scope.`
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Verify step

export interface VerifyOutcome {
  cmd: string;
  ok: boolean;
  /** null when the command was killed by a signal/timeout rather than exiting. */
  exitCode: number | null;
  outputTail: string;
}

const VERIFY_TAIL_CHARS = 2000;

export function runVerifyCommand(cmd: string, cwd: string, timeoutMs = 600_000): VerifyOutcome {
  try {
    const r = spawnSync(cmd, {
      shell: true,
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const tail = combined.length > VERIFY_TAIL_CHARS ? '…' + combined.slice(-VERIFY_TAIL_CHARS) : combined;
    return { cmd, ok: r.status === 0, exitCode: r.status, outputTail: tail.trimEnd() };
  } catch (e: any) {
    return { cmd, ok: false, exitCode: null, outputTail: `verify command failed to spawn: ${e.message}` };
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Enforcement + report

/** The two journal calls the contract needs — an interface so tests can mock it. */
export interface JournalLike {
  listSessionFiles(sessionId: string): string[];
  rollbackSession(sessionId: string): Promise<{ filesRestored: number; txnsRolled: number }>;
}

export interface ContractUsage {
  tokens: number;
  costUsd: number;
  wallTimeMs: number;
  iterations: number;
}

export type ContractVerdict = 'GREEN' | 'ROLLED-BACK' | 'FAILED-KEPT';

export interface ContractRunOutcome {
  verdict: ContractVerdict;
  filesChanged: string[];
  /** True when the journal rollback ran (files listed above were reverted). */
  reverted: boolean;
  rollback: { filesRestored: number; txnsRolled: number } | null;
  verify: VerifyOutcome | null;
  usage: ContractUsage;
  failReasons: string[];
}

/**
 * Post-run enforcement: gather files changed, run the verify command, decide the
 * verdict, and roll back on failure when the contract says so. Journal + verify
 * runner are injectable so the whole decision path is unit-testable.
 */
export async function enforceContract(opts: {
  contract: AutonomyContract;
  cwd: string;
  sessionId: string;
  usage: ContractUsage;
  /** Set when the run ended on BudgetExceededError (any budgetType, incl. stall/time). */
  budgetExceeded: { type?: string; message: string } | null;
  /** Set on any other agent-loop error (stream failure, fatal exception, …). */
  agentError: string | null;
  journal: JournalLike;
  runVerify?: (cmd: string, cwd: string) => VerifyOutcome;
}): Promise<ContractRunOutcome> {
  const { contract } = opts;

  // Snapshot the touched files BEFORE any rollback flips their status.
  let filesChanged: string[] = [];
  try {
    filesChanged = opts.journal.listSessionFiles(opts.sessionId);
  } catch {
    // Journal unavailable (e.g. no writes ever happened) — report proceeds with none.
  }

  const failReasons: string[] = [];
  if (opts.budgetExceeded) {
    failReasons.push(`budget exceeded (${opts.budgetExceeded.type ?? 'unknown'}): ${opts.budgetExceeded.message}`);
  }
  if (opts.agentError) {
    failReasons.push(`agent error: ${opts.agentError}`);
  }

  let verify: VerifyOutcome | null = null;
  if (contract.verifyCmd) {
    verify = (opts.runVerify ?? runVerifyCommand)(contract.verifyCmd, opts.cwd);
    if (!verify.ok) {
      failReasons.push(`verify failed (exit ${verify.exitCode ?? 'killed'}): ${contract.verifyCmd}`);
    }
  }

  const failed = failReasons.length > 0;
  let rollback: { filesRestored: number; txnsRolled: number } | null = null;
  let reverted = false;
  if (failed && contract.rollbackOnFail) {
    try {
      rollback = await opts.journal.rollbackSession(opts.sessionId);
      reverted = true;
    } catch (e: any) {
      // Rollback itself failed — the tree may be dirty; surface it loudly in the report.
      failReasons.push(`ROLLBACK FAILED: ${e.message} — working tree may contain partial changes`);
    }
  }

  const verdict: ContractVerdict = !failed ? 'GREEN' : reverted ? 'ROLLED-BACK' : 'FAILED-KEPT';
  return { verdict, filesChanged, reverted, rollback, verify, usage: opts.usage, failReasons };
}

/** Exit code 0 only on GREEN — everything else must read as failure to CI/scripts. */
export function exitCodeFor(verdict: ContractVerdict): number {
  return verdict === 'GREEN' ? 0 : 1;
}

export function buildRunReport(o: ContractRunOutcome): string {
  const lines: string[] = [];
  const bar = '═'.repeat(56);
  lines.push(bar);
  lines.push('RUN REPORT');
  lines.push(bar);

  const verdictLabel =
    o.verdict === 'GREEN' ? 'GREEN (changes kept)'
    : o.verdict === 'ROLLED-BACK' ? 'ROLLED-BACK (writes reverted — clean tree)'
    : 'FAILED-KEPT (failed, rollback not requested or failed)';
  lines.push(`Verdict:    ${verdictLabel}`);

  if (o.filesChanged.length === 0) {
    lines.push('Files:      none changed');
  } else {
    lines.push(`Files:      ${o.filesChanged.length} changed${o.reverted ? ' (all reverted)' : ''}`);
    for (const f of o.filesChanged) {
      lines.push(`  - ${f}${o.reverted ? '  [reverted]' : ''}`);
    }
    if (o.rollback) {
      lines.push(`Rollback:   ${o.rollback.filesRestored} file(s) restored across ${o.rollback.txnsRolled} txn(s)`);
    }
  }

  const secs = (o.usage.wallTimeMs / 1000).toFixed(0);
  lines.push(
    `Spend:      ${o.usage.tokens.toLocaleString()} tokens · $${o.usage.costUsd.toFixed(4)} · ` +
    `${o.usage.iterations} iteration(s) · ${secs}s wall`,
  );

  if (o.verify) {
    lines.push(`Verify:     \`${o.verify.cmd}\` → ${o.verify.ok ? 'PASS (exit 0)' : `FAIL (exit ${o.verify.exitCode ?? 'killed'})`}`);
    if (o.verify.outputTail) {
      for (const l of o.verify.outputTail.split('\n').slice(-12)) lines.push(`  │ ${l}`);
    }
  } else {
    lines.push('Verify:     (not requested)');
  }

  if (o.failReasons.length > 0) {
    lines.push('Failures:');
    for (const r of o.failReasons) lines.push(`  ✗ ${r}`);
  }

  lines.push(bar);
  return lines.join('\n');
}
