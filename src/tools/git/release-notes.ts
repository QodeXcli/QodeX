/**
 * `generate_release_notes` — distil a git range into user-facing release notes.
 *
 * Pipeline:
 *   1. Resolve the range (auto-detect latest tag if `from` is omitted).
 *   2. Read commits via `git log` (NUL-separated fields to survive any subject chars).
 *   3. Classify each commit via conventional-commit + heuristic fallback (see
 *      classify-commits.ts). The agent can re-bucket items afterwards if the
 *      heuristic guessed wrong.
 *   4. Emit markdown (default) or JSON. Optionally prepend to CHANGELOG.md and
 *      bump version in package.json — both gated on explicit flags so a
 *      read-only "show me the notes" stays read-only.
 *
 * The tool is intentionally deterministic. LLM prose-polishing is the agent's job
 * (it has the structured output + can rewrite it). That keeps the tool fast,
 * provider-agnostic, and re-runnable.
 */
import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { git, gitOrThrow, isGitRepo } from './git-runner.js';
import { bucket, formatMarkdown, type RawCommit, type CategoryBuckets } from './classify-commits.js';

const ReleaseNotesArgs = z.object({
  from: z.string().optional().describe(
    'Starting ref (exclusive). Tag, branch, or sha. If omitted, uses the most recent tag reachable from `to`; if no tags exist, uses the repo root.',
  ),
  to: z.string().optional().describe('Ending ref (inclusive). Default: HEAD.'),
  scope: z.enum(['user', 'all']).optional().describe(
    'user (default): hide internal/refactor/docs/chore. all: include every category.',
  ),
  format: z.enum(['markdown', 'json']).optional().describe('Output format. Default markdown.'),
  heading: z.string().optional().describe(
    'Top-level heading for the markdown output. Default: derived from `to` (or "Unreleased").',
  ),
  write_to_changelog: z.boolean().optional().describe(
    'If true, prepend the rendered markdown to CHANGELOG.md at the repo root. Creates the file if missing. Default false.',
  ),
  bump: z.enum(['patch', 'minor', 'major', 'none']).optional().describe(
    'If set to patch/minor/major, also bump version in package.json. Default none. Ignored when no package.json exists.',
  ),
  max_commits: z.number().int().min(1).max(2000).optional().describe('Hard cap on commits scanned. Default 500.'),
});

type Args = z.infer<typeof ReleaseNotesArgs>;

export class GenerateReleaseNotesTool extends Tool<Args> {
  name = 'generate_release_notes';
  description = 'Generate user-facing release notes from a git commit range. Classifies commits (Features/Fixes/Breaking/Perf/Docs/Internal) via conventional-commit prefixes + heuristics. Returns markdown by default. Optional: prepend to CHANGELOG.md and bump package.json version. Read-only unless write_to_changelog or bump is set.';
  isReadOnly = false; // becomes effectively read-only when neither write flag is set; conservative default
  isDestructive = false;
  argsSchema = ReleaseNotesArgs;

  async execute(args: Args, ctx: ToolContext): Promise<ToolResult> {
    if (!await isGitRepo(ctx.cwd, ctx.signal)) {
      return { content: '[NOT_A_GIT_REPO] Current directory is not a git working tree.', isError: true };
    }

    const to = args.to ?? 'HEAD';
    const scope = args.scope ?? 'user';
    const format = args.format ?? 'markdown';
    const maxCommits = args.max_commits ?? 500;

    // Resolve `from`. If omitted, find latest tag reachable from `to`; else fall back to repo root.
    let from = args.from;
    let fromSource = 'user-provided';
    if (!from) {
      const r = await git(['describe', '--tags', '--abbrev=0', to], { cwd: ctx.cwd, signal: ctx.signal });
      if (r.exitCode === 0 && r.stdout.trim()) {
        from = r.stdout.trim();
        fromSource = `latest tag: ${from}`;
      } else {
        // No tag — use root commit
        try {
          const root = (await gitOrThrow(['rev-list', '--max-parents=0', to], { cwd: ctx.cwd, signal: ctx.signal })).trim().split('\n')[0];
          if (!root) {
            return { content: '[EMPTY_REPO] Could not find any commits.', isError: true };
          }
          from = root;
          fromSource = `repo root (no tags found)`;
        } catch (e: any) {
          return { content: `[ERROR] Could not resolve starting commit: ${e.message}`, isError: true };
        }
      }
    }

    // Build the range expression. `from..to` excludes `from` itself — desired behaviour
    // when `from` is a tag (we don't want to re-list its commits).
    const range = `${from}..${to}`;

    const commits = await readCommits(ctx.cwd, range, maxCommits, ctx.signal);
    if (commits.length === 0) {
      return {
        content: `[NO_CHANGES] No commits in range ${range} (${fromSource}).`,
        metadata: { range, fromSource, count: 0 },
      };
    }

    const buckets = bucket(commits);
    const heading = args.heading ?? deriveHeading(to);
    const md = formatMarkdown(buckets, { scope, heading, range });

    let written: string[] = [];
    if (args.write_to_changelog) {
      const changelogPath = path.join(ctx.cwd, 'CHANGELOG.md');
      const existing = await readIfExists(changelogPath);
      const header = existing.startsWith('# ') ? '' : '# Changelog\n\n';
      const next = header + md + (existing ? '\n' + existing.replace(/^# Changelog\s*\n+/, '') : '');
      await fs.writeFile(changelogPath, next, 'utf-8');
      written.push('CHANGELOG.md');
      ctx.emit({ type: 'diff', path: changelogPath, before: existing || null, after: next });
    }

    if (args.bump && args.bump !== 'none') {
      const pkgPath = path.join(ctx.cwd, 'package.json');
      const pkgRaw = await readIfExists(pkgPath);
      if (pkgRaw) {
        const pkg = JSON.parse(pkgRaw);
        const oldV = String(pkg.version ?? '0.0.0');
        const newV = bumpSemver(oldV, args.bump);
        pkg.version = newV;
        const next = JSON.stringify(pkg, null, 2) + '\n';
        await fs.writeFile(pkgPath, next, 'utf-8');
        written.push(`package.json (${oldV} → ${newV})`);
        ctx.emit({ type: 'diff', path: pkgPath, before: pkgRaw, after: next });
      }
    }

    if (format === 'json') {
      return {
        content: JSON.stringify({ range, fromSource, heading, scope, buckets: bucketsToJson(buckets), written }, null, 2),
        metadata: { range, count: commits.length, written },
      };
    }

    const suffix = written.length > 0 ? `\n\n_Wrote: ${written.join(', ')}_` : '';
    return {
      content: md + suffix,
      metadata: { range, fromSource, count: commits.length, written },
    };
  }
}

async function readIfExists(p: string): Promise<string> {
  try { return await fs.readFile(p, 'utf-8'); } catch { return ''; }
}

async function readCommits(
  cwd: string,
  range: string,
  maxCommits: number,
  signal?: AbortSignal,
): Promise<RawCommit[]> {
  // Field separator NUL, record separator unit-separator (\x1f). Body comes last because
  // it can contain newlines; we terminate each commit with \x1e (record separator).
  const fmt = `%h%x00%ad%x00%an%x00%s%x00%b%x1e`;
  const r = await git(['log', `-${maxCommits}`, '--date=short', '--no-merges', `--pretty=format:${fmt}`, range], { cwd, signal });
  if (r.exitCode !== 0) {
    // Unknown ref, etc — surface a clean error
    const err = (r.stderr || r.stdout).trim();
    throw new Error(err || `git log exited ${r.exitCode}`);
  }
  if (!r.stdout.trim()) return [];

  return r.stdout.split('\x1e')
    .map(rec => rec.replace(/^\n/, ''))
    .filter(rec => rec.length > 0)
    .map(rec => {
      const [sha, date, author, subject, body] = rec.split('\x00');
      return {
        sha: sha!.trim(),
        date: date!.trim(),
        author: author!.trim(),
        subject: subject!.trim(),
        body: (body ?? '').trim(),
      };
    });
}

function deriveHeading(to: string): string {
  if (to === 'HEAD' || !to) return 'Unreleased';
  return to;
}

function bumpSemver(v: string, kind: 'patch' | 'minor' | 'major'): string {
  // Tolerant of "v1.2.3", "1.2.3-rc1", etc. Pre-release suffix is dropped on bump.
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`Cannot parse version: ${v}`);
  let [_, maj, min, pat] = m;
  let M = parseInt(maj!), m2 = parseInt(min!), p = parseInt(pat!);
  if (kind === 'major') { M++; m2 = 0; p = 0; }
  else if (kind === 'minor') { m2++; p = 0; }
  else { p++; }
  return `${M}.${m2}.${p}`;
}

function bucketsToJson(b: CategoryBuckets): Record<string, Array<{ sha: string; subject: string; scope?: string; date: string; author: string }>> {
  const out: Record<string, Array<{ sha: string; subject: string; scope?: string; date: string; author: string }>> = {};
  for (const [k, arr] of Object.entries(b) as Array<[string, CategoryBuckets[keyof CategoryBuckets]]>) {
    out[k] = arr.map(c => ({ sha: c.sha, subject: c.subject, scope: c.scope, date: c.date, author: c.author }));
  }
  return out;
}
