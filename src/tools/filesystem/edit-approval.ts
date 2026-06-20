import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import type { ToolContext } from '../base.js';
import { logger } from '../../utils/logger.js';

/**
 * Shared interactive edit-approval flow — the "surgical assistant" gate.
 *
 * Before any edit/write tool commits to disk on an `ask` decision, it shows the
 * red/green diff and pauses for the user with four choices:
 *   [Y] Accept   — write the proposal as-is
 *   [E] Edit     — open the proposal in $EDITOR, write whatever the user saves
 *   [C] Continue — soft reject: bounce it back so the model reconsiders (don't abort)
 *   [N] Reject   — hard stop on this edit
 *
 * The diff render + pause + arrow-key prompt already exist (DiffViewer + Confirmation
 * in the TUI, surfaced via ctx.emit('diff') + ctx.askUser). This centralizes the
 * answer handling and adds the Edit / Continue paths so all three edit tools behave
 * identically instead of each rolling its own yes/no.
 */

export type EditDecision =
  | { kind: 'accept'; content: string }   // write this content (original or user-edited)
  | { kind: 'reject' }                     // hard stop
  | { kind: 'revise' };                    // soft: model should try a different edit

const APPROVE_OPTIONS = ['accept', 'edit', 'continue', 'reject'];

/** Map a raw answer to a decision branch. PURE (the editor side-effect lives in
 *  confirmEdit). Tolerant of full words or first letters from the Confirmation UI. */
export function interpretApprovalAnswer(answer: string): 'accept' | 'edit' | 'revise' | 'reject' {
  const a = (answer || '').trim().toLowerCase();
  if (a === 'accept' || a === 'yes' || a === 'y' || a === 'always') return 'accept';
  if (a === 'edit' || a === 'e') return 'edit';
  if (a === 'continue' || a === 'c' || a === 'revise') return 'revise';
  return 'reject'; // 'no' / 'n' / 'reject' / anything unrecognized → safe default
}

/** Open `content` in the user's editor, return the edited text (or null on failure). */
function editInEditor(content: string, originalPath: string): string | null {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) return null; // no editor configured → caller falls back
  try {
    const dir = mkdtempSync(join(tmpdir(), 'qodex-edit-'));
    const ext = extname(originalPath) || '.txt';
    const tmp = join(dir, `proposal${ext}`);
    writeFileSync(tmp, content, 'utf8');
    // stdio:'inherit' hands the TTY to the editor; on exit Ink repaints.
    execFileSync(editor, [tmp], { stdio: 'inherit' });
    return readFileSync(tmp, 'utf8');
  } catch (e: any) {
    // Editor flow failed (mkdtemp/write/spawn/read). Log so it's traceable —
    // otherwise this is indistinguishable from "no editor configured".
    logger.warn('External editor flow failed; falling back', { editor, err: e?.message ?? String(e) });
    return null;
  }
}

/**
 * Run the approval flow for a pending edit. Returns the decision the tool acts on.
 * `after` is the fully-resolved proposed file content.
 */
export async function confirmEdit(
  ctx: ToolContext,
  opts: { rel: string; before: string | null; after: string; absPath: string; permReq: any; label: string },
): Promise<EditDecision> {
  const { prepareDiffPreview } = await import('../../utils/ui-limits.js');
  const preview = prepareDiffPreview(opts.rel, opts.before ?? '', opts.after);
  ctx.emit({ type: 'diff', path: preview.path, before: preview.before, after: preview.after });

  const answer = await ctx.askUser(opts.label, APPROVE_OPTIONS);
  const branch = interpretApprovalAnswer(answer);

  if (branch === 'reject') return { kind: 'reject' };
  if (branch === 'revise') return { kind: 'revise' };
  if (branch === 'edit') {
    const edited = editInEditor(opts.after, opts.absPath);
    // No $EDITOR or editor failed → fall back to accepting the original proposal
    // rather than silently dropping the change.
    return { kind: 'accept', content: edited ?? opts.after };
  }
  return { kind: 'accept', content: opts.after };
}

/** The standard tool-result for a soft "continue/revise" reject. */
export function reviseResult(rel: string): { content: string; isError: boolean } {
  return {
    content:
      `[USER_REVISE] The user reviewed your proposed edit to ${rel} and wants a different ` +
      `approach to the same goal. Do NOT re-apply the same edit. Reconsider, then propose a ` +
      `revised edit (or explain what you'd change and why).`,
    isError: true,
  };
}
