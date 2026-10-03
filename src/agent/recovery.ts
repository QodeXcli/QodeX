import { createHash } from 'crypto';
import type { ToolCall } from '../session/store.js';

// ── Tool-family helpers for the loop guards and gates ─────────────────────────────

/**
 * Tool families that act on the agent's "own computer" (browser, desktop, workflows,
 * missions, vault). They are not code changes, so the coding-discipline gates (the
 * architecture/preflight plan gate and the per-turn git auto-snapshot) don't apply to
 * them — same reasoning as the existing `artifact_` exemption.
 */
const GATE_EXEMPT_PREFIXES = ['artifact_', 'browser_', 'computer_use_', 'workflow_', 'mission_', 'vault_'];

/** True when the preflight plan gate and the auto-snapshot must skip this tool. PURE. */
export function isGateExemptTool(name: string): boolean {
  return GATE_EXEMPT_PREFIXES.some(p => name.startsWith(p));
}

/** Status pollers: called with identical args while a mission / job / server progresses. */
const STATUS_POLL_TOOLS = new Set([
  'mission_status', 'mission_list',
  'background_job_status', 'background_job_list', 'background_job_log',
  'dev_server_log',
]);

/**
 * Tools whose result depends on live external state (a web page, the screen, a running
 * mission / job). Calling them repeatedly with identical args is NORMAL when the state
 * changes in between (scroll → snapshot while reading a long page; polling a mission's
 * status), so the loop guards key them by name + args + a hash of the RESULT: only a
 * truly identical call+result repeat counts as "stuck". PURE.
 */
export function isStateDependentTool(name: string): boolean {
  return name.startsWith('browser_') || name.startsWith('computer_use_') || STATUS_POLL_TOOLS.has(name);
}

/** Short stable hash of a tool result (8 hex chars). PURE. */
export function resultHash(content: unknown): string {
  const s = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return createHash('md5').update(s).digest('hex').slice(0, 8);
}

/**
 * Effective per-call timeout in seconds. `toolSec` is the tool's own `timeoutSeconds`:
 *   - undefined / negative / NaN → the global budget.toolTimeoutSeconds;
 *   - 0 → no timeout for this tool (it must honor ctx.signal; sub-agent-style tools carry
 *     their own wall-clock budget);
 *   - n > 0 → max(global, n), so a tool can only ever get MORE time than the global cap.
 * A global value ≤ 0 also means "no timeout" (budget convention: 0 = unlimited). PURE.
 */
export function resolveToolTimeoutSeconds(globalSec: number | undefined, toolSec: number | undefined): number {
  const g = typeof globalSec === 'number' && Number.isFinite(globalSec) ? globalSec : 300;
  if (typeof toolSec === 'number' && Number.isFinite(toolSec) && toolSec >= 0) {
    if (toolSec === 0) return 0;
    return g <= 0 ? 0 : Math.max(g, toolSec);
  }
  return g <= 0 ? 0 : g;
}

/**
 * Turn a raw provider/stream error string into a clear, actionable message for the USER
 * (distinct from transformError, which formats errors for the MODEL mid-run). The common
 * painful case is a 429 from a rate-limited endpoint — especially OpenRouter ":free" models,
 * which share a heavily-contended pool — where the raw "429 Provider returned error" tells
 * the user nothing about why or what to do. We keep the original text but prepend a plain
 * explanation and a concrete next step.
 */
export function explainStreamError(raw: string): string {
  const msg = String(raw ?? '').trim();
  const is429 = /\b429\b|too many requests|rate.?limit/i.test(msg);
  const is401 = /\b401\b|unauthorized|invalid api key|no api key/i.test(msg);
  const is402 = /\b402\b|payment required|insufficient (credit|quota|balance)|quota/i.test(msg);
  const is5xx = /\b50[0-9]\b|server error|bad gateway|service unavailable/i.test(msg);

  if (is429) {
    return (
      `Rate limited (429): the model provider is refusing new requests right now.\n` +
      `This is the provider throttling you, not a QodeX error. QodeX already retried with backoff.\n` +
      `What to do:\n` +
      `  • If you're on a free/shared model (e.g. an OpenRouter ":free" model or a free Gemini tier),\n` +
      `    that pool is heavily contended — wait a bit, or switch to a paid model for reliable throughput.\n` +
      `  • Try another model with --model (e.g. openai/gpt-4o-mini), or run a local model with no limits.\n` +
      `  • If you have a Retry-After hint from the provider dashboard, wait that long.\n` +
      `(raw: ${msg.slice(0, 160)})`
    );
  }
  if (is401) {
    return (
      `Authentication failed (401): the provider rejected your API key.\n` +
      `Check that the right env var is exported and matches the provider in your config.\n` +
      `(raw: ${msg.slice(0, 160)})`
    );
  }
  if (is402) {
    return (
      `Payment/quota issue (402): the provider says this key is out of credit or quota.\n` +
      `Top up the account or switch to a free/local model with --model.\n` +
      `(raw: ${msg.slice(0, 160)})`
    );
  }
  if (is5xx) {
    return (
      `Provider server error: the model endpoint failed on its side (5xx). QodeX retried.\n` +
      `Wait a moment and retry, or switch model with --model.\n` +
      `(raw: ${msg.slice(0, 160)})`
    );
  }
  return msg;
}

export function transformError(err: any, toolCall?: ToolCall): string {
  const code = err.code ?? '';
  const msg = err.message ?? String(err);

  if (err.name === 'AbortError' || err.name === 'CancelledError') {
    return `[CANCELLED] Operation was cancelled. Stop and ask the user how to proceed.`;
  }

  if (code === 'ENOENT') {
    return `[FILE_NOT_FOUND] ${msg}. Verify the path with ls or glob before retrying.`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `[PERMISSION_DENIED] ${msg}. The OS refused access. The user may need to adjust file permissions.`;
  }
  if (code === 'EISDIR') {
    return `[IS_A_DIRECTORY] ${msg}. Use ls instead of read_file on directories.`;
  }
  if (code === 'ENOTDIR') {
    return `[NOT_A_DIRECTORY] ${msg}. Check the path.`;
  }
  if (code === 'EBUSY' || code === 'EAGAIN') {
    return `[FILE_BUSY] ${msg}. Another process may be using this file. Retry once or move on.`;
  }
  if (code === 'ENOSPC') {
    return `[NO_SPACE] ${msg}. Disk full. Tell the user.`;
  }
  if (code === 'BUDGET_EXCEEDED') {
    return `[BUDGET_EXCEEDED] ${msg}. Stop and summarize what you did so far.`;
  }
  if (code === 'PERMISSION_DENIED') {
    return `[USER_DENIED] ${msg}. The user explicitly rejected. Do not retry the same action — try a different approach or ask the user.`;
  }

  // JSON parse error
  if (err instanceof SyntaxError && msg.includes('JSON')) {
    return `[INVALID_JSON] Tool arguments were not valid JSON: ${msg}. Re-output the arguments as strict JSON (double-quoted keys, no trailing commas).`;
  }

  // Provider HTTP errors
  if (err.httpStatus === 429) {
    return `[RATE_LIMITED] ${msg}. Wait briefly and retry, or switch model.`;
  }
  if (err.httpStatus && err.httpStatus >= 500) {
    return `[SERVER_ERROR] ${err.provider ?? 'Provider'} returned ${err.httpStatus}. Retry once. If it persists, switch model.`;
  }

  // Tool name hint for debugging
  const toolHint = toolCall ? ` (during ${toolCall.function.name})` : '';
  return `[ERROR]${toolHint} ${msg}\nRead the error and adjust your approach.`;
}

/**
 * Decide what to do when the model keeps re-reading the SAME file (identical read-only
 * tool + args) across a whole run. This is the signature of the "context too small →
 * model lost its place → restarted the task" loop, which the sliding-window detector
 * misses because each restart sweep is longer than the window.
 *
 *   - 'summarize' (3rd identical read): disable tools next turn and make the model report
 *     what it already found, so the loop turns into a (partial) answer instead of churning.
 *   - 'abort' (5th identical read): the nudge didn't take; end the run with a clear message.
 *
 * Thresholds are intentionally low: a capable run never re-reads the exact same file 3×
 * with no edits in between, and bailing fast beats burning the iteration budget (and, with
 * some local servers, crashing the model under sustained load).
 */
export function readLoopAction(maxIdenticalReads: number): 'none' | 'summarize' | 'abort' {
  if (maxIdenticalReads >= 5) return 'abort';
  if (maxIdenticalReads >= 3) return 'summarize';
  return 'none';
}

/** Final message when readLoopAction says 'abort'. File re-reads get the context-window
 *  explanation; a browser/desktop observation that keeps returning the same result gets
 *  a "the page/screen isn't changing" explanation. PURE. */
export function readLoopAbortMessage(tool: string, count: number, contextWindow: number): string {
  if (isStateDependentTool(tool)) {
    return `I stopped: \`${tool}\` kept returning exactly the same result ${count} times, so the ` +
      `page/screen isn't changing and repeating it won't help. Tell me how to proceed (or take over ` +
      `the browser/desktop yourself), and I'll continue from there.`;
  }
  const ctx = Number.isFinite(contextWindow) ? contextWindow.toLocaleString() : String(contextWindow);
  return `I got stuck re-reading the same files. This codebase is larger than the model's context ` +
    `window (${ctx} tokens), so I keep losing my place and starting over. To finish this, either ` +
    `narrow the task (e.g. “find bugs in src/pages/CartPage.jsx”) or use a model with a larger ` +
    `context window (~/.qodex/config.yaml → providers.*.extraModels[].contextWindow).`;
}

/** The forced-summary nudge when readLoopAction says 'summarize'. PURE. */
export function readLoopSummarizeMessage(tool: string, count: number): string {
  if (isStateDependentTool(tool)) {
    return `[SYSTEM] You have called \`${tool}\` with the same arguments ${count} times and it returned ` +
      `the same result each time — the page/screen is not changing. STOP repeating it. In your NEXT ` +
      `message, report what you have found so far and what is blocking you, in plain text. Tools are ` +
      `disabled for that message.`;
  }
  return `[SYSTEM] You have re-read the same file ${count} times — a sign your context was ` +
    `compacted and you restarted instead of continuing. STOP calling tools. In your NEXT message, ` +
    `list the bugs/issues you have ALREADY found, in plain text. Tools are disabled for that message.`;
}

/** The nudge when detectStuckLoop fires, with advice targeted at the repeated tool. PURE. */
export function stuckLoopMessage(lastTool: string): string {
  let advice: string;
  if (lastTool === 'read_file') {
    advice = ' You are re-reading files you already examined — a sign your context was compacted and you restarted the task instead of continuing it. Do NOT start over. Based on what you have ALREADY read, report your findings now (e.g. the bugs you found) in your reply. If you need more detail on ONE specific thing, use grep with a precise pattern rather than re-reading whole files.';
  } else if (lastTool === 'edit_symbol') {
    advice = ' edit_symbol is failing repeatedly. Switch to edit_text or write_file for the same change. Don\'t retry edit_symbol on this file.';
  } else if (lastTool === 'project_overview') {
    advice = ' project_overview failed. SKIP it for now and use ls + read_file on specific files instead.';
  } else if (isStateDependentTool(lastTool)) {
    advice = ' Each repeat returned the SAME result — the page/screen is not changing. Do something different: act on another element/ref, scroll or navigate somewhere new, wait for a specific change (browser_wait_for), or take a fresh look (browser_snapshot / computer_use_screenshot) and re-plan.';
  } else {
    advice = ' Try a fundamentally different approach (different tool, different file, different angle).';
  }
  return `[SYSTEM] You've called \`${lastTool}\` with the same arguments 3+ times in a row. This isn't working.${advice} If you genuinely can't proceed, explain to the user IN ONE SENTENCE what's blocking you and stop. Do not apologize repeatedly. Do not loop.`;
}

/**
 * Detect "stuck" loops in the recent tool-call history. Two shapes:
 *
 *   (a) The same call repeated 3+ times in a row — read_file(x), read_file(x), read_file(x).
 *   (b) A multi-call CYCLE repeated back-to-back — read_file(a), read_file(b), read_file(c),
 *       read_file(a), read_file(b), read_file(c). This is the common "context overflowed,
 *       the model lost its place and restarted, re-reading the same entry files" loop.
 *       Period-1 detection (a) misses it because no single call repeats consecutively.
 *
 * The caller keeps a bounded window (~10) of recent calls, so larger cycles are caught on
 * their second repetition.
 */
/** Classify a tool error result into a coarse code for loop detection. */
export function errorCodeOf(content: string): string {
  if (typeof content !== 'string') return 'ERROR';
  const m = content.match(/^\s*\[([A-Z_]+)\]/);
  if (m) return m[1]!;
  if (/does not exist|not found|no such file/i.test(content)) return 'FILE_NOT_FOUND';
  return 'ERROR';
}

/**
 * A result can be a "soft failure": the tool itself returned success (exit 0, isError=false) but the
 * OUTPUT shows the action achieved nothing — "Vite not found", "command not found", "Unknown tool",
 * "Unknown option". The model treats these as progress and keeps probing with slightly different
 * commands, which is exactly the 90-minute pnpm/vite thrash we observed: every `ls … || echo "not
 * found"` exits 0, so `isError` is false and the error-loop detector never sees it. Counting these
 * as loop signal lets the existing detectErrorLoop nudge fire and break the thrash early.
 */
export function looksFutile(content: string): boolean {
  if (typeof content !== 'string') return false;
  return /does not exist|not found|no such file|cannot find|unknown (tool|option|command)|command not found/i.test(
    content,
  );
}

/**
 * Detect a "guessing" loop: the SAME tool returning the SAME kind of error repeatedly, even
 * when the arguments differ each time. `detectStuckLoop` (identical-args) misses this — e.g. a
 * model reading Header.tsx, App.tsx, Navbar.jsx (all FILE_NOT_FOUND) on a .jsx project. Returns
 * the offending tool + error code when it crosses `threshold`, else null.
 */
export function detectErrorLoop(
  recentErrors: Array<{ name: string; code: string }>,
  threshold = 3,
): { name: string; code: string; count: number } | null {
  if (recentErrors.length < threshold) return null;
  const counts = new Map<string, number>();
  for (const e of recentErrors) {
    const key = `${e.name}|${e.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count >= threshold) {
      const [name, code] = key.split('|');
      return { name: name!, code: code!, count };
    }
  }
  return null;
}

export function detectStuckLoop(recentToolCalls: Array<{ name: string; argsHash: string }>): boolean {
  const n = recentToolCalls.length;
  if (n < 3) return false;
  const keys = recentToolCalls.map(c => `${c.name}|${c.argsHash}`);

  // (a) period-1: last three identical
  if (keys[n - 1] === keys[n - 2] && keys[n - 2] === keys[n - 3]) return true;

  // (b) period-p: the last 2p calls are two identical halves (a repeated cycle)
  for (let p = 2; p <= Math.floor(n / 2); p++) {
    let cycle = true;
    for (let i = 0; i < p; i++) {
      if (keys[n - 1 - i] !== keys[n - 1 - i - p]) { cycle = false; break; }
    }
    if (cycle) return true;
  }
  return false;
}
