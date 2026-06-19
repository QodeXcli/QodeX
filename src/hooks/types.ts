/**
 * Lifecycle hooks let users inject shell commands at well-defined points in the agent's
 * execution. Common uses:
 *   - PostToolUse: run prettier/eslint/black after a write
 *   - PreToolUse:  refuse dangerous tool calls (audit script returns non-zero)
 *   - SessionStart: print environment summary, load project-specific env
 *   - PreCompact:  backup conversation before truncation
 *   - SessionEnd:  cleanup / push metrics
 *
 * Hooks run as shell commands. They receive context via environment variables
 * (QODEX_TOOL_NAME, QODEX_TOOL_ARGS_JSON, QODEX_TOOL_RESULT, QODEX_FILE_PATHS,
 * QODEX_SESSION_ID, QODEX_CWD, QODEX_HOOK_EVENT) and signal results via exit code +
 * stdout/stderr.
 *
 * Veto semantics:
 *   - PreToolUse: any blocking hook (default: blocking=true) that exits non-zero
 *     CANCELS the tool call. The hook's stdout/stderr is surfaced to the model as
 *     the tool's error so it knows why and can adapt.
 *   - PostToolUse: exit code is informational only. stdout is APPENDED to the tool's
 *     result text so the model can see e.g. lint warnings.
 *   - SessionStart / SessionEnd / PreCompact: best-effort, never block; output shows
 *     in the UI but isn't fed to the model.
 */

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact';

export interface HookConfig {
  /**
   * Tool-name matcher (regex string). Only used for PreToolUse / PostToolUse.
   * Examples: "write_file|edit_file|edit_symbol|multi_edit", "^bash$", ".*".
   * If absent, the hook matches every tool.
   */
  matcher?: string;
  /** Shell command. Runs through `sh -c` (POSIX) or the system default shell. */
  command: string;
  /** Timeout in seconds. Default 30. */
  timeout?: number;
  /** Working directory. Default = session cwd. */
  cwd?: string;
  /**
   * For PreToolUse only. If true (default), non-zero exit vetoes the tool call.
   * Set false for hooks that should run as informational guards but never block.
   */
  blocking?: boolean;
  /** Human-readable name shown in /hooks and in logs. */
  name?: string;
}

export interface HooksConfig {
  PreToolUse?: HookConfig[];
  PostToolUse?: HookConfig[];
  SessionStart?: HookConfig[];
  SessionEnd?: HookConfig[];
  PreCompact?: HookConfig[];
}

export interface HookContext {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  /** Tool name for Pre/PostToolUse. */
  toolName?: string;
  /** JSON-encoded args string for Pre/PostToolUse. */
  toolArgsJson?: string;
  /** Plain-text result string for PostToolUse. */
  toolResult?: string;
  /** File paths touched by the tool, extracted heuristically from args. */
  filePaths?: string[];
}

export interface HookRunResult {
  hookName: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface DispatchResult {
  /** stdout collected from every hook that ran (in matcher order). */
  outputs: string[];
  /** Combined PreToolUse veto messages, if any blocking hook exited non-zero. */
  vetoMessage?: string;
  /** Number of hooks that ran. */
  ranCount: number;
  /** Per-hook detail for telemetry / debugging. */
  runs: HookRunResult[];
}

export function isVetoed(r: DispatchResult): boolean {
  return r.vetoMessage !== undefined;
}
