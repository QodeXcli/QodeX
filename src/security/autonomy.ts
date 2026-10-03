/**
 * Autonomous ("auto") approval policy — what runs without asking when the session
 * approval mode is 'auto' (see ApprovalMode in permissions.ts).
 *
 * The user's rules for auto mode:
 *   - Inside the project (the workspace roots) everything runs without asking: edits,
 *     shell, installs, commits, ordinary pushes, deletes of project files.
 *   - Destructive actions OUTSIDE the project still ask: deleting/overwriting paths
 *     outside the workspace roots, history rewrites on remotes (force push, remote
 *     branch deletes), deleting remote data (cloud/k8s/terraform/db/package registries),
 *     and system-level commands (sudo, shutdown, disks).
 *   - Purchases, payments, passwords and sending messages are Sentinel-critical and
 *     always need a human (src/sentinel/guard.ts) — not decided here.
 *   - The agent's own clarifying questions are not asked: the model decides, states its
 *     assumption and continues (autonomousQuestionReply).
 *
 * Hard deny patterns and user deny rules (permissions.ts) still outrank this policy.
 *
 * Shell commands are parsed (src/security/shell-parse.ts) and every segment of a chain is
 * classified by command position (src/security/shell-analyze.ts): `ls && git push -f`,
 * `echo x > ~/.bashrc`, `cd ~ && rm -rf proj2`, `find ~ -delete`, `bash -c '…'`,
 * `ssh host 'rm -rf /srv'` are all seen for what they do.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { analyzeShell, displayPath, isLocalHost, type ShellFinding } from './shell-analyze.js';

export type AutoDecision = 'allow' | 'ask' | 'deny';

export interface AutoVerdict {
  decision: AutoDecision;
  /** Why it was not simply allowed (shown in the prompt / audit). */
  reason?: string;
}

export interface AutoPolicyContext {
  /** Working directory of the tool call. */
  cwd: string;
  /** Workspace roots: cwd plus configured extra roots and the system temp dir. */
  roots: readonly string[];
}

/**
 * Tools whose permission `operation` is a shell command line. Only these get command
 * parsing, the irreversible tier and always-ask patterns — never an edit path, an MCP tool
 * name, a mission goal or a Sentinel operation string.
 */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(['shell', 'bash', 'background_job_start']);
export function isCommandTool(tool: string): boolean { return COMMAND_TOOLS.has(tool); }

/** File tools whose `operation` is a path (relative to the call's cwd, or absolute). */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_text', 'multi_edit', 'multi_file_edit', 'edit_symbol']);
export function isFileEditTool(tool: string): boolean { return FILE_EDIT_TOOLS.has(tool); }

/** Marker on results/messages when auto mode needed a human and none answered. */
export const AUTO_NEEDS_HUMAN_TAG = '[AUTO_MODE_NEEDS_HUMAN]';

/**
 * The message for an action auto mode will not take on its own when no human can approve
 * it (headless `--yes`, a detached worker). Names every way to approve.
 */
export function needsHumanMessage(what: string, reason?: string): string {
  return (
    `${AUTO_NEEDS_HUMAN_TAG} Not done: ${what}${reason ? ` — ${reason}` : ''}. Auto mode runs everything inside the ` +
    'project on its own, but this needs a human and none is attached to this run. To approve it: run qodex ' +
    'interactively (the TUI), or attach the control center (qodex control / /control) or Telegram (qodex telegram ' +
    'start) and approve it there. Do not retry it or work around it; tell the user what is waiting.'
  );
}

/** A directory too broad to be "the project": the filesystem root, $HOME, or a parent of $HOME. */
function tooBroad(p: string): boolean {
  const home = os.homedir();
  if (p === path.parse(p).root) return true;
  if (!home) return false;
  const h = path.resolve(home);
  return p === h || h.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Workspace roots for auto mode: cwd, extra configured roots, and the temp dir(s). PURE.
 *
 * A cwd that is `/`, $HOME or a parent of $HOME is NOT a root: started from the home
 * directory, "inside the project" would otherwise mean "anywhere in your home". Extra roots
 * (user config `approval.extraRoots`, `~` allowed) are taken as given.
 */
export function workspaceRoots(cwd: string, extraRoots: readonly string[] = []): string[] {
  const base = path.resolve(cwd || process.cwd());
  const home = os.homedir();
  const extra = (Array.isArray(extraRoots) ? extraRoots : [])
    .filter(r => typeof r === 'string' && r.trim())
    .map(r => (r === '~' || r.startsWith('~/') ? path.join(home, r.slice(1)) : r))
    .map(r => path.resolve(base, r));
  const temps = [os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])];
  const roots = [...(tooBroad(base) ? [] : [base]), ...extra, ...temps].filter(Boolean).map(r => path.resolve(r));
  return [...new Set(roots)];
}

/** Is `p` (resolved against cwd) inside one of the roots? PURE (no symlink resolution). */
export function isInsideRoots(p: string, ctx: AutoPolicyContext): boolean {
  const abs = path.resolve(ctx.cwd, p);
  return ctx.roots.some(r => abs === r || abs.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

function realish(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const r = fs.realpathSync.native(cur);
      return tail.length ? path.join(r, ...tail) : r;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/**
 * Like isInsideRoots, with symlinks resolved on both sides (a link in the project that
 * points at ~/.ssh is outside; /tmp → /private/tmp on macOS is still the temp root).
 */
export function isInsideRootsReal(p: string, ctx: AutoPolicyContext): boolean {
  const abs = path.resolve(ctx.cwd, p);
  if (abs.startsWith('/dev/')) return false;
  const real = realish(abs);
  const roots = [...new Set([...ctx.roots.map(r => path.resolve(r)), ...ctx.roots.map(r => realish(path.resolve(r)))])];
  return roots.some(r => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

/** Auto/edits verdict for a file edit: inside the roots → allow, else ask with the path. */
export function editPathDecision(operation: string, ctx: AutoPolicyContext): AutoVerdict {
  const op = (operation ?? '').trim();
  if (!op) return { decision: 'allow' };
  if (isInsideRootsReal(op, ctx)) return { decision: 'allow' };
  const abs = path.resolve(ctx.cwd, op);
  return { decision: 'ask', reason: `writes ${displayPath(abs)} (outside the project)` };
}

function summarize(findings: ShellFinding[]): string {
  const reasons = [...new Set(findings.map(f => f.reason))];
  return reasons.length > 3 ? `${reasons.slice(0, 3).join('; ')}; …` : reasons.join('; ');
}

/**
 * Sentinel's non-critical permission operations look like `sentinel:<category> <domain|-> <tool>`.
 * Auto mode asks only for remote data deletion and account changes on hosts that are not
 * this machine (a `-` domain is unknown, so it asks too).
 */
function sentinelDecision(operation: string): AutoVerdict {
  const m = /^sentinel:(\S+)\s+(\S+)/.exec(operation);
  if (!m) return { decision: 'allow' };
  const category = m[1]!;
  const domain = m[2] === '-' ? null : m[2]!;
  if (category !== 'delete' && category !== 'account') return { decision: 'allow' };
  if (domain && isLocalHost(domain)) return { decision: 'allow' };
  const what = category === 'delete' ? 'deletes data' : 'changes account or security settings';
  return { decision: 'ask', reason: `${what} on ${domain ?? 'a remote service'} (remote data)` };
}

/**
 * Decide a permission request in auto mode. `operation` is what the tool passed to the
 * permission engine (a shell command for shell-like tools, a path for edits, a Sentinel
 * operation string for browser/desktop/http/MCP actions). Everything not listed in the
 * module comment is allowed.
 */
export function autonomousDecision(
  req: { tool: string; operation: string },
  ctx: AutoPolicyContext,
): AutoVerdict {
  const op = req.operation ?? '';
  if (isCommandTool(req.tool)) {
    const a = analyzeShell(op, { cwd: ctx.cwd, roots: ctx.roots });
    const asks = a.findings.filter(f => f.autoAsk);
    if (asks.length) return { decision: 'ask', reason: summarize(asks) };
    return { decision: 'allow' };
  }
  if (op.startsWith('sentinel:')) return sentinelDecision(op);
  if (isFileEditTool(req.tool)) return editPathDecision(op, ctx);
  return { decision: 'allow' };
}

/**
 * Commands auto mode runs inside the project that cannot be undone by the journal
 * (rm -rf, git reset --hard, git clean -f, git checkout -- .). Callers take a snapshot
 * first when one is available. Returns the reason, or null.
 */
export function localDestructiveReason(command: string, ctx: AutoPolicyContext): string | null {
  const a = analyzeShell(command, { cwd: ctx.cwd, roots: ctx.roots });
  const f = a.findings.find(x => x.kind === 'local-destructive' && !x.autoAsk);
  return f ? f.reason : null;
}

/**
 * What the model gets back when it asks the user something in auto mode (ask_user, a
 * clarifying question, a plan approval): decide yourself and say so.
 */
export function autonomousQuestionReply(question: string, options?: readonly string[]): string {
  const choices = options && options.length ? ` Options were: ${options.join(', ')}.` : '';
  return (
    '[AUTONOMOUS_MODE] The user turned on auto mode and is not answering questions.' +
    ` Decide this yourself with your best judgment ("${question.slice(0, 200)}").${choices}` +
    ' State the assumption you made in your final answer, then continue the task.'
  );
}
