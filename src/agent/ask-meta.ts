/**
 * What an approval prompt is about — carried next to the prompt text from the tool that
 * asks (via the agent loop's ToolContext.askUser) to the surface that shows it (the TUI,
 * through the operator hub), so the surface can re-check a pending prompt against the
 * approval policy when the user switches modes (Shift+Tab into auto) instead of guessing
 * from the text.
 *
 *   - 'permission': a tool asked after the PermissionEngine said 'ask' for `tool` +
 *     `operation` (shell command, file path, mission goal). Re-evaluating that request
 *     under the new mode is what decides whether the prompt may be answered for the user.
 *   - 'sentinel': a Sentinel approval (src/sentinel/guard.ts). Sentinel applies its own
 *     auto-mode rules, and critical ones (purchase, payment, credential, send, integrity)
 *     always need the human's explicit answer — never answered on a mode switch.
 *   - 'question': the agent's own question (ask_user). Not a permission at all.
 *
 * A prompt without meta is "unknown" and must be treated as the strictest kind.
 */

export type AskKind = 'permission' | 'sentinel' | 'question';

export interface AskMeta {
  kind: AskKind;
  /** Tool name the permission request was evaluated for ('permission' only). */
  tool?: string;
  /** Operation string the PermissionEngine evaluated ('permission' only). */
  operation?: string;
}

/** askUser with the optional prompt metadata (older askers simply ignore the third arg). */
export type AskUserFn = (prompt: string, options?: string[], meta?: AskMeta) => Promise<string>;

/** Is `v` a well-formed AskMeta? PURE (used where meta crosses an untyped boundary). */
export function isAskMeta(v: unknown): v is AskMeta {
  if (!v || typeof v !== 'object') return false;
  const k = (v as { kind?: unknown }).kind;
  if (k !== 'permission' && k !== 'sentinel' && k !== 'question') return false;
  const { tool, operation } = v as { tool?: unknown; operation?: unknown };
  if (tool !== undefined && typeof tool !== 'string') return false;
  if (operation !== undefined && typeof operation !== 'string') return false;
  return true;
}
