/**
 * "Send now" keeps the running work: the TUI ends the running turn at once so queued messages
 * go in right away (Ctrl+Enter, or Ctrl+X Ctrl+S), and a foreground shell command that is
 * running at that moment is NOT killed — it moves to a background job (background_job_status /
 * background_job_log / background_job_cancel) and its tool call returns [MOVED_TO_BACKGROUND].
 *
 * runForeground() is the shell tool's exec wrapper: it registers the command while it runs and
 * gives exec its own abort signal, which follows the turn's signal only until the command is
 * detached. detachForegroundShells() is what the TUI calls. The rest is pure helpers for it.
 */
import { randomBytes } from 'crypto';
import type { ExecRequest, ExecResult } from '../../runtime/types.js';
import { adoptRunningJob } from '../builtin/background-jobs.js';

/**
 * Optional hook a runtime may call once the process is spawned (src/runtime/exec.ts does not
 * yet): its pid, and a way to drop its foreground timeout so a moved command runs to completion.
 * Without it a moved command keeps its timeout_seconds ceiling and its pid is unknown.
 */
export type OnSpawn = (h: { pid?: number; releaseTimeout?: () => void }) => void;

export interface MovedShell {
  jobId: string;
  command: string;
  cwd: string;
  pid?: number;
  /** Set when the runtime could not drop the foreground timeout: it still stops then. */
  timeoutSec?: number;
}

export type ForegroundOutcome = { kind: 'done'; ran: ExecResult } | ({ kind: 'moved' } & MovedShell);

interface Entry { id: string; sessionId?: string; detach: () => MovedShell | null }
const running = new Map<string, Entry>();

/** Output kept while in the foreground, so a moved job starts with what was already printed. */
const SEED_CAP = 100_000;
function keepTail(s: string, add: string): string {
  const next = s + add;
  return next.length > SEED_CAP ? next.slice(next.length - SEED_CAP) : next;
}

/**
 * Run `req` through `exec` as a foreground command that "send now" can detach. Resolves with
 * the exec result, or `{ kind: 'moved' }` as soon as it was moved to a background job.
 */
export async function runForeground(
  exec: (req: ExecRequest) => Promise<ExecResult>,
  req: ExecRequest,
  meta: { description?: string; sessionId?: string } = {},
): Promise<ForegroundOutcome> {
  const outer = req.signal;
  const inner = new AbortController();
  const follow = () => { if (!inner.signal.aborted) inner.abort(outer?.reason); };
  if (outer) {
    if (outer.aborted) follow();
    else outer.addEventListener('abort', follow, { once: true });
  }
  let out = '';
  let err = '';
  let toJob: { out: (l: string) => void; err: (l: string) => void } | null = null;
  let pid: number | undefined;
  let releaseTimeout: (() => void) | undefined;
  const onSpawn: OnSpawn = (h) => { pid = h.pid; releaseTimeout = h.releaseTimeout; };
  const startedAt = Date.now();

  const execReq: ExecRequest & { onSpawn: OnSpawn } = {
    ...req,
    signal: inner.signal,
    onStdoutLine: (line) => {
      if (toJob) { toJob.out(line); return; }
      out = keepTail(out, line + '\n');
      req.onStdoutLine?.(line);
    },
    onStderrLine: (line) => {
      if (toJob) { toJob.err(line); return; }
      err = keepTail(err, line + '\n');
      req.onStderrLine?.(line);
    },
    onSpawn,
  };
  const finished = exec(execReq);

  // `resolve` is set while the command is in the foreground; detach() consumes it once.
  const fg: { resolve: ((m: MovedShell) => void) | null } = { resolve: null };
  const movedP = new Promise<MovedShell>((resolve) => { fg.resolve = resolve; });
  const entry: Entry = {
    id: randomBytes(4).toString('hex'),
    sessionId: meta.sessionId,
    detach: () => {
      const resolve = fg.resolve;
      if (!resolve) return null;
      fg.resolve = null;
      // The turn ending must no longer kill it; background_job_cancel aborts it instead.
      outer?.removeEventListener('abort', follow);
      try { releaseTimeout?.(); } catch { /* keep its timeout */ }
      const job = adoptRunningJob({
        command: req.command, description: meta.description, cwd: req.cwd, pid, startedAt,
        stdout: out, stderr: err, timeoutMs: releaseTimeout ? 0 : req.timeoutMs,
        cancel: () => { if (!inner.signal.aborted) inner.abort('background_job_cancel'); },
      });
      toJob = { out: (l) => job.appendStdout(l + '\n'), err: (l) => job.appendStderr(l + '\n') };
      finished.then((r) => job.finish(r), (e) => job.fail(e?.message ?? String(e)));
      const m: MovedShell = {
        jobId: job.id, command: req.command, cwd: req.cwd, pid,
        ...(releaseTimeout ? {} : { timeoutSec: Math.round(req.timeoutMs / 1000) }),
      };
      resolve(m);
      return m;
    },
  };
  running.set(entry.id, entry);
  try {
    return await Promise.race([
      finished.then((ran): ForegroundOutcome => ({ kind: 'done', ran })),
      movedP.then((m): ForegroundOutcome => ({ kind: 'moved', ...m })),
    ]);
  } finally {
    running.delete(entry.id);
    if (fg.resolve) { fg.resolve = null; outer?.removeEventListener('abort', follow); } // finished in the foreground
  }
}

/**
 * Does a shell run under `sessionId`'s turn? Its own calls and its sub-agents'
 * (`<sid>/sub-…`, `/fanout-…`, `/scout-…`) do; side runs (`<sid>/bgN`, /background) keep
 * running on their own and do not. PURE.
 */
export function belongsToTurn(shellSession: string | undefined, sessionId: string): boolean {
  if (!shellSession) return false;
  if (shellSession === sessionId) return true;
  if (!shellSession.startsWith(`${sessionId}/`)) return false;
  return !/^bg\d+(\/|$)/.test(shellSession.slice(sessionId.length + 1));
}

const inScope = (e: Entry, sessionId?: string) => sessionId === undefined || belongsToTurn(e.sessionId, sessionId);

/** Move the running foreground shell commands (of `sessionId`'s turn; all without one) to background jobs. */
export function detachForegroundShells(opts: { sessionId?: string } = {}): MovedShell[] {
  const out: MovedShell[] = [];
  for (const e of [...running.values()]) {
    if (!inScope(e, opts.sessionId)) continue;
    const m = e.detach();
    if (m) out.push(m);
  }
  return out;
}

/** Foreground shell commands running right now (of `sessionId`'s turn; all without one). */
export function foregroundShellCount(opts: { sessionId?: string } = {}): number {
  return [...running.values()].filter(e => inScope(e, opts.sessionId)).length;
}

/** The tool result of a command moved to the background. PURE. */
export function movedResult(m: MovedShell): string {
  return `[MOVED_TO_BACKGROUND] job ${m.jobId} — check it with background_job_status\n` +
    `\`${m.command}\` keeps running in the background (cwd ${m.cwd}${m.pid ? `, pid ${m.pid}` : ''}` +
    `${m.timeoutSec ? `; it still stops at its ${m.timeoutSec}s timeout` : ''}). ` +
    `Its output so far and from now on: background_job_log id="${m.jobId}".`;
}

const shortCmd = (c: string) => (c.length > 60 ? `${c.slice(0, 57)}…` : c);

/**
 * The next turn after "send now": what the user queued (plain messages merged), with a line
 * saying the previous turn was ended early and which commands still run as background jobs.
 * With nothing queued but a steering note pending, a short "continue" (the loop injects the
 * note itself). PURE.
 */
export function buildSendNowPrompt(queued: string[], moved: MovedShell[]): string {
  const jobs = moved.length
    ? ` Still running as background jobs: ${moved.map(m => `${m.jobId} (\`${shortCmd(m.command)}\`)`).join(', ')} — check them with background_job_status / background_job_log.`
    : '';
  const head = `[Send now: I ended the previous turn early so this goes in right away.${jobs}]`;
  const text = queued.map(q => q.trim()).filter(Boolean).join('\n\n');
  return text ? `${head}\n\n${text}` : `${head}\n\nContinue with my latest note.`;
}

/** The history line the TUI shows when it sends now. PURE. */
export function sendNowLine(moved: MovedShell[]): string {
  return moved.length
    ? `⏩ Sending now — the running turn ends; kept running as background job${moved.length > 1 ? 's' : ''}: ${moved.map(m => `${m.jobId} (${shortCmd(m.command)})`).join(', ')}`
    : '⏩ Sending now — the running turn ends.';
}

export const SEND_NOW_TIP =
  '  It applies after the running command finishes — Ctrl+Enter (or Ctrl+X Ctrl+S) sends it now; the command keeps running in the background.';

export const SEND_NOW_HINT =
  'Send now (Ctrl+Enter or Ctrl+X Ctrl+S) sends what you queued right away — nothing is queued. Type a message first.';

/**
 * Is this keypress "send now"? Ctrl+Enter arrives as a bare LF on many terminals, as CSI-u
 * (ESC[13;5u) with the kitty protocol, or ESC[27;5;13~ with xterm modifyOtherKeys; Ctrl+X Ctrl+S
 * is the chord for terminals that send plain Enter. Returns 'arm' for the chord's Ctrl+X. PURE.
 */
export function sendNowKey(input: string, key: { ctrl?: boolean; return?: boolean }, chordArmed: boolean): 'send' | 'arm' | null {
  if (chordArmed && key.ctrl && input === 's') return 'send';
  if (key.ctrl && input === 'x') return 'arm';
  if (input === '\n' && !key.return) return 'send';
  if (/\[13;5u$/.test(input) || /\[27;5;13~$/.test(input)) return 'send';
  return null;
}
