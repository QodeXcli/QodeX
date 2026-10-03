/**
 * Sentinel under the autonomous 'auto' approval mode (src/security/autonomy.ts).
 *
 * In auto mode Sentinel's non-critical classifications (navigation, downloads, desktop
 * input, page scripts, HTTP writes, vault fills, uploads of project files, ...) run
 * without a prompt — they are still audited. What still asks a human:
 *   - Sentinel-critical (purchase, payment, credential, send, integrity) — decided in
 *     guard.ts exactly as in every other mode (a human, or blocked when nobody is there);
 *   - deleting or changing data on a remote service: the 'delete', 'account' and
 *     'publish' categories anywhere but a local/private host (an MCP server or a desktop
 *     app counts as remote: auto mode can't tell where the data lives), and an HTTP
 *     DELETE to a public host;
 *   - uploading a file from OUTSIDE the project's workspace roots to a website.
 *
 * "Autonomous" is the process-wide approval mode, or a per-conversation permission
 * engine marked with markAutonomousPermissions (the chat bot's `/auto on`).
 *
 * Also holds the one-shot "a human approved this call in Sentinel's prompt" marks that
 * let the MCP tool wrapper skip its own, second prompt for the same call.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isAutonomousMode, type PermissionEngine, type PermissionRequest } from '../security/permissions.js';
import { autonomousDecision, isInsideRoots, workspaceRoots } from '../security/autonomy.js';
import { isPrivateHost } from './policy.js';
import type { ActionClassification } from './types.js';

// ── which runs are autonomous ────────────────────────────────────────────────

const autonomousEngines = new WeakSet<object>();

/**
 * Mark a permission engine (usually a per-conversation wrapper) as running the
 * autonomous policy even though the process-wide approval mode is not 'auto'.
 * Sentinel, the MCP wrapper and mission_start read it through isAutonomousContext().
 */
export function markAutonomousPermissions<T extends object>(engine: T): T {
  autonomousEngines.add(engine);
  return engine;
}

/**
 * A per-conversation permission engine that runs the autonomous 'auto' policy on top of
 * `base` while the process-wide mode stays what it is (the chat bot's `/auto on`):
 *   - whatever `base` decides without asking stands — deny rules and hard-deny patterns
 *     refuse, read-only tools / allow rules / grants run;
 *   - what `base` would ask about is decided by autonomousDecision() (src/security/
 *     autonomy.ts) for this conversation's workspace roots: allow, or ask a human.
 * Sentinel, the MCP wrapper and mission_start see it as autonomous (isAutonomousContext),
 * so their auto-mode rules apply too; Sentinel-critical never goes through the engine.
 * Grants written through it (rememberDecision) land on `base`.
 */
export function autonomousPermissions(base: PermissionEngine, cwd: string, extraRoots: readonly string[] = []): PermissionEngine {
  const where = rootsFor(cwd, extraRoots);
  const engine = Object.create(base) as PermissionEngine;
  const detailed = (req: PermissionRequest): ReturnType<PermissionEngine['evaluateDetailed']> => {
    const d = base.evaluateDetailed(req);
    // The process already runs the autonomous policy, or base decided without asking.
    if (d.decision !== 'ask' || isAutonomousMode()) return d;
    let v: 'allow' | 'ask' | 'deny';
    try { v = autonomousDecision({ tool: req.tool, operation: req.operation }, where).decision; } catch { v = 'ask'; }
    return { decision: v, via: d.via };
  };
  engine.evaluateDetailed = detailed;
  engine.evaluate = (req: PermissionRequest) => detailed(req).decision;
  return markAutonomousPermissions(engine);
}

/** Is this call running under the autonomous 'auto' approval policy? */
export function isAutonomousContext(ctx: { permissions?: unknown } | null | undefined): boolean {
  if (isAutonomousMode()) return true;
  const p = ctx && typeof ctx === 'object' ? (ctx as { permissions?: unknown }).permissions : undefined;
  return !!p && typeof p === 'object' && autonomousEngines.has(p as object);
}

// ── the auto-mode gate for non-critical classifications ──────────────────────

/** Line every prompt carries when it is asked although auto mode is on. */
export const AUTO_MODE_ASKS = 'Auto mode still asks';

/**
 * Was this prompt asked although auto mode is on (it carries the auto-mode reason)?
 * Automatic answerers (the chat bot's /auto, mission auto mode) must leave it to a human.
 */
export function isAutoModeAskPrompt(prompt: string): boolean {
  return String(prompt ?? '').includes(AUTO_MODE_ASKS);
}

/** Categories that delete or change data held by someone else (a web service, an MCP server). */
const REMOTE_DATA_CATEGORIES = new Set(['delete', 'account', 'publish']);

const MCP_NAME_RE = /^mcp(?::|__)/i;

function mcpServerOf(toolName: string): string {
  if (/^mcp:/i.test(toolName)) return toolName.split(':')[1] || 'an MCP server';
  if (/^mcp__/i.test(toolName)) return toolName.split('__')[1] || 'an MCP server';
  return 'an MCP server';
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

function real(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

/**
 * Is a local file inside the workspace roots? Symlinks are resolved for paths that
 * exist (a link in the project pointing at ~/.ssh is outside).
 */
export function insideWorkspace(file: string, cwd: string, roots: readonly string[]): boolean {
  const abs = path.resolve(cwd, expandHome(String(file ?? '')));
  const rootsReal = [...new Set([...roots, ...roots.map(real)])];
  return isInsideRoots(real(abs), { cwd, roots: rootsReal }) && isInsideRoots(abs, { cwd, roots: rootsReal });
}

/** Workspace roots for a call: its cwd, the user's approval.extraRoots and the temp dir. */
export function rootsFor(cwd: string | undefined, extraRoots: readonly string[] = []): { cwd: string; roots: string[] } {
  const base = cwd || process.cwd();
  const extra = extraRoots.filter(r => typeof r === 'string' && r.trim()).map(r => path.resolve(base, expandHome(r)));
  return { cwd: base, roots: workspaceRoots(base, extra) };
}

function verbFor(category: string): string {
  if (category === 'delete') return 'deletes data';
  if (category === 'account') return 'changes account or security settings';
  return 'publishes or deploys (push / deploy / release / merge)';
}

/**
 * Why auto mode still asks about this NON-critical classification, or null when it
 * runs without a prompt. Critical / low-risk / unclassified calls return null (critical
 * is never decided here — guard.ts always sends it to a human). PURE except for the
 * realpath of upload files.
 */
export function autoModeAskReason(
  toolName: string,
  cls: ActionClassification,
  args: Record<string, unknown> | undefined,
  where: { cwd: string; roots: readonly string[] },
): string | null {
  if (!cls.category || cls.risk === 'low' || cls.risk === 'critical') return null;
  const a = args && typeof args === 'object' ? args : {};

  if (REMOTE_DATA_CATEGORIES.has(cls.category)) {
    const host = cls.domain ?? '';
    if (host && isPrivateHost(host)) return null; // your own dev server / LAN device
    const verb = verbFor(cls.category);
    if (host) return `it ${verb} on ${host}, a remote service — auto mode runs this only on local/private hosts.`;
    if (MCP_NAME_RE.test(toolName)) return `it ${verb} through the MCP server "${mcpServerOf(toolName)}", a remote service.`;
    if (toolName.startsWith('computer_use_')) return `it ${verb} in a desktop app — auto mode can't tell whether that data is local.`;
    // A browser page with no host (about:blank, file://) or a workflow without a start URL:
    // nothing remote is involved here; a replayed step is reviewed again on its own page.
    if (toolName.startsWith('browser_') || toolName === 'workflow_run') return null;
    return `it ${verb} and auto mode can't tell whether that data is local.`;
  }

  if (toolName === 'http_request' && String(a.method ?? '').toUpperCase() === 'DELETE') {
    const host = cls.domain ?? '';
    if (host && isPrivateHost(host)) return null;
    return `it sends an HTTP DELETE to ${host || 'a remote host'} (deleting data on a server).`;
  }

  if (cls.category === 'upload' && toolName === 'browser_upload') {
    const files = (Array.isArray(a.paths) ? a.paths : [a.paths]).filter((p): p is string => typeof p === 'string' && !!p.trim());
    const outside = files.filter(f => !insideWorkspace(f, where.cwd, where.roots));
    if (outside.length) {
      const names = outside.slice(0, 3).map(f => path.basename(f)).join(', ');
      return `it uploads ${outside.length === 1 ? 'a file' : `${outside.length} files`} from outside the project (${names}) to ${cls.domain || 'a website'}.`;
    }
  }
  return null;
}

// ── "a human already approved this call" (MCP single prompt) ─────────────────

const humanApproved = new WeakMap<object, Map<string, number>>();

/** Sentinel got an explicit human yes (or the session "always") for this ctx + tool call. */
export function recordSentinelApproval(ctx: unknown, toolName: string): void {
  if (!ctx || typeof ctx !== 'object') return;
  const m = humanApproved.get(ctx) ?? new Map<string, number>();
  m.set(toolName, (m.get(toolName) ?? 0) + 1);
  humanApproved.set(ctx, m);
}

/** Forget a stale mark (a new review of the same ctx + tool starts). */
export function clearSentinelApproval(ctx: unknown, toolName: string): void {
  if (!ctx || typeof ctx !== 'object') return;
  humanApproved.get(ctx)?.delete(toolName);
}

/**
 * One-shot: did Sentinel just get a human's approval for this exact call? The MCP
 * wrapper then skips its own "Run MCP tool …?" prompt — the human already answered.
 */
export function takeSentinelApproval(ctx: unknown, toolName: string): boolean {
  if (!ctx || typeof ctx !== 'object') return false;
  const m = humanApproved.get(ctx);
  const n = m?.get(toolName) ?? 0;
  if (n <= 0) return false;
  if (n === 1) m!.delete(toolName); else m!.set(toolName, n - 1);
  return true;
}
