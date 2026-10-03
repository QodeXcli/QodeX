/**
 * Auto-evaluation record — the PURE half of `qodex skill eval`.
 *
 * The eval driver (eval.ts) re-runs a skill's original task in a clean git worktree and
 * checks the produced code against the objective verifier. This module owns the
 * deterministic string work so it's unit-tested: pulling the original prompt out of a
 * captured SKILL.md, formatting the `## Auto-evaluation` section, upserting it without
 * disturbing the rest, and the content-hash CACHE (so re-eval fires on real skill changes,
 * not on the eval result we just wrote, and is skipped within a TTL).
 */
import { createHash } from 'crypto';

export type EvalStatus = 'pass' | 'fail' | 'inconclusive' | 'error';

export interface EvalResult {
  status: EvalStatus;
  /** Which objective checker ran (e.g. 'tsc', 'ruff'), if any. */
  checker?: string;
  /** New errors the verifier found in the produced code. */
  errorCount: number;
  /** Files the replay changed. */
  filesChanged: number;
  /** The model that ran the replay. */
  model: string;
  /** ISO timestamp. */
  at: string;
  /** Short human note (e.g. the error summary, or why it was inconclusive). */
  note?: string;
}

const SECTION = '## Auto-evaluation';

/** Pull the captured task prompt out of a SKILL.md ("## Original request" section). */
export function extractOriginalPrompt(md: string): string | null {
  const m = md.match(/^##\s+Original request\s*\n([\s\S]*?)(?=\n##\s|\n*$)/m);
  const body = m?.[1]?.trim();
  return body && body.length ? body : null;
}

/** Hash of the skill's CONTENT, excluding the auto-eval section — so writing an eval
 *  result doesn't change the hash, but editing the skill body does. */
export function skillContentHash(md: string): string {
  const withoutEval = stripEvalSection(md);
  return createHash('sha1').update(withoutEval.trim()).digest('hex').slice(0, 12);
}

function stripEvalSection(md: string): string {
  // Remove from "## Auto-evaluation" up to the next "## " heading or EOF.
  return md.replace(/\n*##\s+Auto-evaluation[\s\S]*?(?=\n##\s|$)/, '\n');
}

/** Render the `## Auto-evaluation` block (includes the content hash for cache checks). */
export function formatEvalSection(result: EvalResult, contentHash: string): string {
  const lines = [
    SECTION,
    `- status: ${result.status}`,
    `- files changed: ${result.filesChanged}`,
    `- new errors: ${result.errorCount}`,
  ];
  if (result.checker) lines.push(`- checker: ${result.checker}`);
  lines.push(`- model: ${result.model}`);
  lines.push(`- evaluated: ${result.at}`);
  lines.push(`- content-hash: ${contentHash}`);
  if (result.note) lines.push(`- note: ${result.note.replace(/\n+/g, ' ').slice(0, 200)}`);
  return lines.join('\n') + '\n';
}

/** Replace an existing `## Auto-evaluation` section, or append one. PURE. */
export function upsertEvalSection(md: string, section: string): string {
  const cleaned = stripEvalSection(md).trimEnd();
  return `${cleaned}\n\n${section.trimEnd()}\n`;
}

export interface CacheCheck { skip: boolean; reason: string }

/**
 * Should we skip eval because the skill content is unchanged since the last eval AND
 * we're within the TTL? Reads the prior section's content-hash + evaluated time.
 */
export function shouldSkipEval(md: string, ttlMs: number, nowMs: number): CacheCheck {
  const hashNow = skillContentHash(md);
  const prevHash = md.match(/^- content-hash:\s*([0-9a-f]+)/m)?.[1];
  const prevAt = md.match(/^- evaluated:\s*(.+)$/m)?.[1]?.trim();
  if (!prevHash || prevHash !== hashNow) return { skip: false, reason: 'skill changed since last eval (or never evaluated)' };
  if (prevAt) {
    const prevMs = Date.parse(prevAt);
    if (Number.isFinite(prevMs) && nowMs - prevMs < ttlMs) {
      return { skip: true, reason: `unchanged and evaluated ${Math.round((nowMs - prevMs) / 3600000)}h ago (within TTL)` };
    }
  }
  return { skip: false, reason: 'TTL elapsed' };
}

/** Derive a pass/fail/inconclusive status from a replay's objective outcome. */
export function deriveStatus(filesChanged: number, ran: boolean, errorCount: number): EvalStatus {
  if (filesChanged === 0) return 'inconclusive';       // the skill produced no change to check
  if (!ran) return 'inconclusive';                      // no checker available for this language
  return errorCount === 0 ? 'pass' : 'fail';
}
