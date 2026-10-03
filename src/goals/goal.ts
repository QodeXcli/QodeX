/**
 * Standing goals — `/goal <objective> [--check "<cmd>"] [--max N]`.
 *
 * A goal keeps the agent working ACROSS turns until "done" is proven by evidence, not
 * by the model saying so: after each run the goal's check command runs (e.g. `npm test`);
 * a non-zero exit feeds its output back as the next turn ("the goal is not met yet,
 * here is the evidence") until the check passes or the round cap is hit. Without a check
 * the model must end its answer with a GOAL_MET line that cites evidence (a command it
 * ran and its result); a bare claim does not count.
 *
 * This module is PURE except `checkGoal`, which runs the check through the headless
 * contract's verify runner. The TUI and headless runners own the loop.
 */
import { runVerifyCommand, type VerifyOutcome } from '../agent/autonomy-contract.js';

export type GoalStatus = 'active' | 'met' | 'gave-up' | 'cleared';

export interface StandingGoal {
  objective: string;
  /** Shell command whose exit code 0 means "done" (optional). */
  check?: string;
  /** Rounds allowed after the first run before giving up. */
  maxRounds: number;
  /** Rounds used so far (one per agent run started for this goal). */
  rounds: number;
  status: GoalStatus;
  startedAt: number;
  /** Last evidence (check output tail, or the model's cited evidence). */
  lastEvidence?: string;
}

export const DEFAULT_GOAL_ROUNDS = 8;
export const MAX_GOAL_ROUNDS = 50;

export type GoalCommand =
  | { kind: 'set'; objective: string; check?: string; maxRounds: number }
  | { kind: 'status' }
  | { kind: 'clear' }
  | { kind: 'error'; message: string };

/** Split args the way a shell would (quotes may start mid-token: --check="npm test"). PURE. */
function tokenize(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < raw.length) cur += raw[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c; inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) { out.push(cur); cur = ''; inToken = false; }
    } else {
      cur += c; inToken = true;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

/** Parse `/goal …` arguments (the text after `/goal`). PURE. */
export function parseGoalCommand(rawArgs: string): GoalCommand {
  const raw = rawArgs.trim();
  if (!raw || raw === 'status') return { kind: 'status' };
  if (raw === 'clear' || raw === 'off' || raw === 'stop' || raw === 'cancel') return { kind: 'clear' };
  const tokens = tokenize(raw);
  const words: string[] = [];
  let check: string | undefined;
  let maxRounds = DEFAULT_GOAL_ROUNDS;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--check' || t === '--verify') {
      check = tokens[++i];
      if (!check) return { kind: 'error', message: '--check needs a command, e.g. --check "npm test"' };
    } else if (t.startsWith('--check=') || t.startsWith('--verify=')) {
      check = t.slice(t.indexOf('=') + 1);
    } else if (t === '--max' || t === '--rounds') {
      const n = Number(tokens[++i]);
      if (!Number.isInteger(n) || n < 1) return { kind: 'error', message: '--max needs a whole number of rounds (1-50)' };
      maxRounds = Math.min(n, MAX_GOAL_ROUNDS);
    } else {
      words.push(t);
    }
  }
  const objective = words.join(' ').trim();
  if (!objective) return { kind: 'error', message: 'Usage: /goal <what done looks like> [--check "<command>"] [--max N]' };
  return { kind: 'set', objective, check: check?.trim() || undefined, maxRounds };
}

export function newGoal(objective: string, check: string | undefined, maxRounds: number, now = Date.now()): StandingGoal {
  return { objective, check, maxRounds, rounds: 0, status: 'active', startedAt: now };
}

/** The model's own "done" line when there is no check command. */
const GOAL_MET_RE = /^\s*GOAL_MET\s*:\s*(.{12,})$/im;

/** Evidence the model cited with a GOAL_MET line, if any. PURE. */
export function citedEvidence(finalText: string): string | null {
  const m = GOAL_MET_RE.exec(finalText ?? '');
  return m ? m[1]!.trim() : null;
}

export interface GoalVerdict {
  met: boolean;
  evidence: string;
}

/** Decide whether the goal is met after a run: the check command, else cited evidence. */
export function checkGoal(goal: StandingGoal, finalText: string, cwd: string, timeoutMs?: number): GoalVerdict {
  if (goal.check) {
    const v: VerifyOutcome = runVerifyCommand(goal.check, cwd, timeoutMs);
    const head = `\`${goal.check}\` exited ${v.exitCode ?? 'abnormally'}`;
    return { met: v.ok, evidence: v.outputTail ? `${head}\n${v.outputTail}` : head };
  }
  const cited = citedEvidence(finalText);
  return cited
    ? { met: true, evidence: cited }
    : { met: false, evidence: 'The answer did not end with a "GOAL_MET: <evidence>" line citing a check you ran and its result.' };
}

/** checkGoal without blocking the event loop (the TUI keeps rendering while tests run). */
export async function checkGoalAsync(goal: StandingGoal, finalText: string, cwd: string, timeoutMs = 600_000): Promise<GoalVerdict> {
  if (!goal.check) return checkGoal(goal, finalText, cwd);
  const { spawn } = await import('child_process');
  return new Promise<GoalVerdict>((resolve) => {
    let out = '';
    let settled = false;
    const finish = (ok: boolean, code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const tail = (out + extra).length > 4000 ? '…' + (out + extra).slice(-4000) : out + extra;
      const head = `\`${goal.check}\` exited ${code ?? 'abnormally'}`;
      resolve({ met: ok, evidence: tail.trim() ? `${head}\n${tail.trimEnd()}` : head });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(goal.check!, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      resolve({ met: false, evidence: `check failed to start: ${e?.message ?? e}` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(false, null, '\n(check timed out)'); }, timeoutMs);
    const add = (d: Buffer) => { out += d.toString(); if (out.length > 64_000) out = out.slice(-32_000); };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    child.on('error', (e) => finish(false, null, `\n${e.message}`));
    child.on('close', (code) => finish(code === 0, code));
  });
}

export type GoalNext = { action: 'done'; goal: StandingGoal } | { action: 'continue'; goal: StandingGoal; prompt: string } | { action: 'give-up'; goal: StandingGoal };

/** What to do after a run finished while a goal is active. PURE. */
export function nextGoalStep(goal: StandingGoal, verdict: GoalVerdict): GoalNext {
  const g: StandingGoal = { ...goal, lastEvidence: verdict.evidence };
  if (verdict.met) return { action: 'done', goal: { ...g, status: 'met' } };
  if (g.rounds >= g.maxRounds) return { action: 'give-up', goal: { ...g, status: 'gave-up' } };
  return { action: 'continue', goal: { ...g, rounds: g.rounds + 1 }, prompt: goalContinuationPrompt(g, verdict.evidence) };
}

/** The turn fed back to the agent while the goal is not met yet. PURE. */
export function goalContinuationPrompt(goal: StandingGoal, evidence: string): string {
  const ev = evidence.length > 3000 ? '…' + evidence.slice(-3000) : evidence;
  return [
    `[STANDING GOAL — round ${goal.rounds + 1} of ${goal.maxRounds}] The goal is not met yet:`,
    `  ${goal.objective}`,
    '',
    goal.check ? `Evidence (the goal's check \`${goal.check}\` failed):` : 'Why it does not count as done yet:',
    ev,
    '',
    goal.check
      ? 'Keep working until that check passes. Fix the cause, not the check.'
      : 'Keep working. When it is really done, end your answer with one line: GOAL_MET: <the command you ran and its result>.',
  ].join('\n');
}

/** Instruction appended to the first turn of a goal. PURE. */
export function goalKickoffPrompt(goal: StandingGoal): string {
  return [
    `[STANDING GOAL] Work until this is done: ${goal.objective}`,
    goal.check
      ? `"Done" is decided by evidence: \`${goal.check}\` must exit 0. You will get its output back if it does not.`
      : 'When it is really done, end your answer with one line: GOAL_MET: <the command you ran and its result>.',
  ].join('\n');
}

/** One-line status for /goal and the status bar. PURE. */
export function describeGoal(goal: StandingGoal | null): string {
  if (!goal) return 'No standing goal. Set one: /goal <what done looks like> [--check "npm test"] [--max 8]';
  const check = goal.check ? ` · check: ${goal.check}` : ' · check: GOAL_MET evidence line';
  const state = goal.status === 'active' ? `round ${goal.rounds}/${goal.maxRounds}` : goal.status;
  return `Goal (${state}): ${goal.objective}${check}`;
}

// ── session state (one standing goal per process) ───────────────────────────

let current: StandingGoal | null = null;

export function getStandingGoal(): StandingGoal | null { return current; }
export function setStandingGoal(g: StandingGoal | null): void { current = g; }
