/**
 * When the user drops a folder into the input, the chip submits a marker:
 *   "[Attached directory: /abs/path] — treat this folder as the project/codebase to work on."
 * Tools that resolve paths against `ctx.cwd` (detect_frontend_stack, analyze_design_system, …)
 * otherwise default to the LAUNCH cwd and miss the attached project's package.json/config.
 * This pulls the path out so the loop can use it as the effective working root for the turn.
 * Pure (no fs) — existence is checked by the caller.
 */

const ATTACHED_DIR_RE = /\[Attached directory:\s*([^\]]+?)\s*\]/;

export function extractAttachedDir(prompt: string): string | null {
  if (!prompt) return null;
  const m = prompt.match(ATTACHED_DIR_RE);
  return m ? m[1]!.trim() : null;
}
