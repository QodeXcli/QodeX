/**
 * Witnessed skill replay — the local-only promotion gate.
 *
 * Hermes-style skill evolution asks a second model whether a draft is "good". On a
 * single local model that question is a self-grade, so QodeX refuses it. A witness is
 * the other kind of evidence: the exact unified diff from a session that already
 * passed the objective verifier, re-applied in a clean git worktree and checked again
 * by the same compiler/linter. No model call. A model never grades its own homework;
 * the toolchain does.
 *
 * Structural helpers here are pure. `replayWitness` is the impure driver behind
 * `qodex skill witness` and the curator's fallback when no independent judge exists.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git } from '../../tools/git/git-runner.js';
import { verifyTouchedFiles } from '../../agent/verification.js';

/** Hard cap so a captured skill stays reviewable. Larger diffs stay out of SKILL.md. */
export const MAX_WITNESS_BYTES = 48 * 1024;

const SECRET = /-----BEGIN [A-Z ]+PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}/;

export type WitnessReplay = 'applied' | 'conflict' | 'absent' | 'rejected';

export interface WitnessVerdict {
  /** True only when the patch applied cleanly AND an objective checker reported 0 new errors. */
  pass: boolean;
  replay: WitnessReplay;
  errorCount: number;
  files: number;
  checker?: string;
  note?: string;
  at: string;
}

export interface SanitizedPatch {
  ok: true;
  patch: string;
  files: string[];
}

export interface RejectedPatch {
  ok: false;
  reason: string;
}

/** File paths named by a unified diff (`diff --git` preferred, `+++ b/` as fallback). */
export function parseDiffFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split('\n')) {
    const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (git) {
      const p = git[2]!;
      if (p !== '/dev/null') files.push(p);
      continue;
    }
  }
  if (files.length === 0) {
    for (const m of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
      const p = (m[1] ?? '').trim();
      if (p && p !== '/dev/null') files.push(p);
    }
  }
  return [...new Set(files)];
}

function unsafePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)) return true;
  return p.split(/[/\\]/).includes('..');
}

/**
 * Accept a unified diff that is small, secret-free, and path-safe.
 * Returns the normalized patch (LF, trailing newline) or a reason to drop it.
 */
export function sanitizeWitnessPatch(raw: string, maxBytes = MAX_WITNESS_BYTES): SanitizedPatch | RejectedPatch {
  const patch = raw.replace(/\r\n/g, '\n').trim();
  if (!patch) return { ok: false, reason: 'empty patch' };
  if (Buffer.byteLength(patch, 'utf8') > maxBytes) return { ok: false, reason: `patch exceeds ${maxBytes} bytes` };
  if (SECRET.test(patch)) return { ok: false, reason: 'patch looks like it contains a secret' };
  const looksDiff = patch.includes('diff --git ') || /^---[ \t]/m.test(patch) || /^@@ /m.test(patch);
  if (!looksDiff) return { ok: false, reason: 'not a unified diff' };
  const files = parseDiffFiles(patch);
  if (files.length === 0) return { ok: false, reason: 'patch names no files' };
  for (const f of files) {
    if (unsafePath(f)) return { ok: false, reason: `unsafe path ${f}` };
  }
  return { ok: true, patch: patch.endsWith('\n') ? patch : patch + '\n', files };
}

/** Pull the fenced witness diff out of a SKILL.md, if one was embedded. */
export function extractWitnessPatch(md: string): string | null {
  const m = md.match(/##\s+Witness patch[\s\S]*?```diff\r?\n([\s\S]*?)\r?\n```/);
  const body = m?.[1];
  return body && body.trim() ? body.replace(/\r\n/g, '\n') : null;
}

const WITNESS_SECTION = '## Witness replay';

export function formatWitnessSection(v: WitnessVerdict): string {
  const lines = [
    WITNESS_SECTION,
    `- pass: ${v.pass}`,
    `- replay: ${v.replay}`,
    `- files: ${v.files}`,
    `- new errors: ${v.errorCount}`,
  ];
  if (v.checker) lines.push(`- checker: ${v.checker}`);
  if (v.note) lines.push(`- note: ${v.note.replace(/\n+/g, ' ').slice(0, 200)}`);
  lines.push(`- at: ${v.at}`);
  return lines.join('\n') + '\n';
}

export function upsertWitnessSection(md: string, section: string): string {
  const cleaned = md.replace(/\n*##\s+Witness replay[\s\S]*?(?=\n##\s|$)/, '\n').trimEnd();
  return `${cleaned}\n\n${section.trimEnd()}\n`;
}

/** Markdown block for a sanitized patch, or a short rejection note. Empty when there is no patch. */
export function renderWitnessBlock(raw: string | undefined): { frontmatter: string; body: string; replayable: boolean } {
  if (!raw || !raw.trim()) return { frontmatter: 'witness: none', body: '', replayable: false };
  const s = sanitizeWitnessPatch(raw);
  if (!s.ok) {
    return {
      frontmatter: 'witness: rejected',
      body: `\n## Witness patch\n\nNot embedded (${s.reason}). Promotion still needs an independent judge.\n`,
      replayable: false,
    };
  }
  return {
    frontmatter: 'witness: replayable',
    body:
      `\n## Witness patch\n\n` +
      `Objective diff from the verified session. Replay with \`qodex skill witness\` — no second model.\n\n` +
      `\`\`\`diff\n${s.patch.trimEnd()}\n\`\`\`\n`,
    replayable: true,
  };
}

export interface VerifyLike {
  ran: boolean;
  errorCount: number;
  checker?: string;
  diagnostics?: Array<{ message: string }>;
}

export type VerifyFn = (opts: { cwd: string; touched: string[] }) => Promise<VerifyLike>;

/**
 * Turn an apply outcome + a verifier result into the promotion verdict.
 * Pure so the gate is unit-tested without git. `pass` requires a checker that ran.
 */
export function verdictFromReplay(input: {
  apply: WitnessReplay;
  files: number;
  verify?: VerifyLike | null;
  note?: string;
  at?: string;
}): WitnessVerdict {
  const at = input.at ?? new Date().toISOString();
  if (input.apply !== 'applied') {
    return {
      pass: false,
      replay: input.apply,
      errorCount: 0,
      files: input.files,
      note: input.note,
      at,
    };
  }
  const verify = input.verify;
  if (!verify?.ran) {
    return {
      pass: false,
      replay: 'applied',
      errorCount: 0,
      files: input.files,
      note: input.note ?? 'patch applied, but no objective checker covers these files — not promoted',
      at,
    };
  }
  const note = verify.errorCount > 0
    ? (verify.diagnostics ?? []).slice(0, 3).map(d => d.message).filter(Boolean).join(' · ') || `${verify.errorCount} new error(s)`
    : input.note;
  return {
    pass: verify.errorCount === 0 && input.files > 0 && !!verify.checker,
    replay: 'applied',
    errorCount: verify.errorCount,
    files: input.files,
    checker: verify.checker,
    note,
    at,
  };
}

/**
 * Re-apply the skill's witness diff on a detached worktree of HEAD and run the
 * real verifier. Never throws: failures are verdicts. The caller's tree is not touched.
 */
export async function replayWitness(
  cwd: string,
  skillMd: string,
  opts: { verify?: VerifyFn; at?: string } = {},
): Promise<WitnessVerdict> {
  const at = opts.at ?? new Date().toISOString();
  const raw = extractWitnessPatch(skillMd);
  if (!raw) return verdictFromReplay({ apply: 'absent', files: 0, note: 'skill has no witness patch', at });
  const sanitized = sanitizeWitnessPatch(raw);
  if (!sanitized.ok) return verdictFromReplay({ apply: 'rejected', files: 0, note: sanitized.reason, at });

  const inside = await git(['rev-parse', '--is-inside-work-tree'], { cwd });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return verdictFromReplay({ apply: 'absent', files: sanitized.files.length, note: 'not a git repository — witness replay needs a worktree off HEAD', at });
  }

  const stamp = `${process.pid}-${Date.now()}`;
  const wt = path.join(os.tmpdir(), `qodex-witness-${stamp}`);
  const patchFile = path.join(os.tmpdir(), `qodex-witness-${stamp}.patch`);
  await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  const add = await git(['worktree', 'add', '--detach', wt, 'HEAD'], { cwd });
  if (add.exitCode !== 0) {
    return verdictFromReplay({
      apply: 'conflict',
      files: sanitized.files.length,
      note: `git worktree add failed: ${(add.stderr || add.stdout).trim().slice(0, 160)}`,
      at,
    });
  }

  try {
    await fs.writeFile(patchFile, sanitized.patch, 'utf8');
    const check = await git(['apply', '--check', '--whitespace=nowarn', patchFile], { cwd: wt });
    if (check.exitCode !== 0) {
      return verdictFromReplay({
        apply: 'conflict',
        files: sanitized.files.length,
        note: `patch does not apply: ${(check.stderr || check.stdout).trim().slice(0, 180)}`,
        at,
      });
    }
    const applied = await git(['apply', '--whitespace=nowarn', patchFile], { cwd: wt });
    if (applied.exitCode !== 0) {
      return verdictFromReplay({
        apply: 'conflict',
        files: sanitized.files.length,
        note: `git apply failed: ${(applied.stderr || applied.stdout).trim().slice(0, 180)}`,
        at,
      });
    }
    const verify = opts.verify
      ? await opts.verify({ cwd: wt, touched: sanitized.files })
      : await verifyTouchedFiles({ cwd: wt, touched: sanitized.files });
    return verdictFromReplay({
      apply: 'applied',
      files: sanitized.files.length,
      verify: {
        ran: verify.ran,
        errorCount: verify.errorCount,
        checker: 'checker' in verify ? (verify as { checker?: string }).checker : undefined,
        diagnostics: verify.diagnostics,
      },
      at,
    });
  } finally {
    await git(['worktree', 'remove', '--force', wt], { cwd }).catch(() => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false }));
    await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
    await fs.rm(patchFile, { force: true }).catch(() => {});
  }
}
