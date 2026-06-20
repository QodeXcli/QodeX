/**
 * Bulk skill installation — multi-skill repos and link-catalog repos.
 *
 * The single-skill installer (installer.ts) clones a source and installs the
 * FIRST SKILL.md it finds. That's wrong for the two most useful real-world
 * shapes:
 *
 *   1. MULTI-SKILL REPO — one repo, many skills, each in its own subdir with a
 *      SKILL.md (e.g. anthropics/skills, obra/superpowers with 30+). We want
 *      ALL of them.
 *
 *   2. LINK-CATALOG REPO — a README that's a curated table of links to OTHER
 *      repos (e.g. abubakarsiddik31/claude-skills-collection). The repo itself
 *      has no SKILL.md; its value is the list of GitHub sources in the markdown.
 *      We parse the GitHub links out and install each.
 *
 * Both are exposed as `installAll(source)`, which auto-detects the shape:
 *   - clone the repo once
 *   - if it contains SKILL.md files anywhere → install every one (multi-skill)
 *   - else if its README has GitHub links → treat as a catalog, install each
 *     linked source (deduped), descending into subdir links via tree/<branch>/<path>
 *
 * Everything shells out to `git` (already required). Failures on individual
 * skills are collected and reported, never abort the whole batch — installing
 * 40 skills and having 2 fail should still leave you 38 installed.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { userSkillsDir, parseSkill } from './loader.js';
import { scanSkillContent } from './security-scan.js';
import { logger } from '../utils/logger.js';

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface BulkInstallResult {
  installed: Array<{ name: string; source: string }>;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ source: string; error: string }>;
}

function run(cmd: string, args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function mkdtemp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Recursively find every directory that directly contains a SKILL.md. */
async function findAllSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const SKIP = new Set(['.git', 'node_modules', '.github', 'dist', 'build', '__pycache__', '.venv']);
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    // Does THIS dir have a SKILL.md?
    if (entries.some(e => e.isFile() && e.name === 'SKILL.md')) {
      found.push(dir);
      // Don't descend further — a skill's own subdirs are its assets, not nested skills.
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name)) {
        await walk(path.join(dir, e.name), depth + 1);
      }
    }
  }
  await walk(root, 0);
  return found;
}

/**
 * Normalize a full GitHub URL into our compact source form.
 *
 *   https://github.com/u/r                                   → gh:u/r
 *   https://github.com/u/r/tree/<ref>/<path>                 → gh:u/r@<ref>#<path>
 *   https://github.com/u/r/blob/<ref>/<path>/SKILL.md        → gh:u/r@<ref>#<path>
 *
 * Crucially, a `blob`/`tree` URL targets ONE subdirectory — so we carry the
 * subpath through (#...) and the installer scopes to it, instead of cloning the
 * whole repo and installing every SKILL.md it can find. A `blob` link to a
 * SKILL.md file points at the file; we strip the trailing /SKILL.md so the
 * subpath is the skill's directory.
 *
 * Anything that's already gh:/github:/local is returned unchanged.
 */
export function normalizeGithubSource(source: string): string {
  const s = source.trim();
  if (s.startsWith('gh:') || s.startsWith('github:')) return s;
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(blob|tree)\/([^/\s]+)((?:\/[^\s?#]+)*))?/.exec(s);
  if (!m) return s; // not a github web URL — leave as-is
  const user = m[1]!;
  const repo = m[2]!.replace(/\.git$/, '');
  const ref = m[4];
  let subpath = m[5] ? m[5].replace(/^\//, '') : '';
  // A blob link points at a file; drop a trailing /SKILL.md (any case) so the
  // subpath is the directory the manifest lives in.
  if (subpath) subpath = subpath.replace(/\/SKILL\.md$/i, '');
  let out = `gh:${user}/${repo}`;
  if (ref) out += `@${ref}`;
  if (subpath) out += `#${subpath}`;
  return out;
}

/** Parse GitHub source links out of a markdown catalog (README). */
export function parseGithubLinksFromMarkdown(md: string): string[] {
  const links = new Set<string>();
  // Match github.com/user/repo and github.com/user/repo/tree/<ref>/<path...>
  const re = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/tree\/([^/\s)]+)((?:\/[^\s)]+)*))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const user = m[1]!;
    const repo = m[2]!.replace(/\.git$/, '');
    // Skip the catalog's own infra links (the site chrome, not skill sources).
    if (/^(features|topics|sponsors|marketplace|security|about|login|signup|settings)$/.test(user)) continue;
    const ref = m[4];
    const subpath = m[5] ? m[5].replace(/^\//, '') : '';
    let spec = `${user}/${repo}`;
    if (ref) spec += `@${ref}`;
    if (subpath) spec += `#${subpath}`; // we carry the subpath after '#'
    links.add(spec);
  }
  return [...links];
}

/** Clone a repo (optionally a ref) shallowly into a temp dir; returns the path. */
function cloneRepo(user: string, repo: string, ref?: string): { dir: string } | { error: string } {
  const tmp = spawnSync('mktemp', ['-d'], { encoding: 'utf-8' });
  const dir = (tmp.stdout || '').trim() || path.join(os.tmpdir(), `qodex-bulk-${Date.now()}`);
  const url = `https://github.com/${user}/${repo}.git`;
  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push(url, dir);
  const r = run('git', args);
  if (!r.ok) {
    // Retry without --branch (ref might be a path-only link, not a real branch)
    if (ref) {
      const r2 = run('git', ['clone', '--depth', '1', url, dir]);
      if (r2.ok) return { dir };
    }
    return { error: `git clone ${url} failed: ${r.stderr.slice(0, 200)}` };
  }
  return { dir };
}

/** Copy one skill dir into ~/.qodex/skills/<name>/, returning its canonical name. */
async function installOneSkillDir(
  srcDir: string,
  source: string,
  force: boolean,
  result: BulkInstallResult,
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(srcDir, 'SKILL.md'), 'utf-8');
  } catch {
    result.failed.push({ source, error: `No SKILL.md in ${srcDir}` });
    return;
  }
  const fmName = extractName(raw);
  const rawName = (fmName ?? path.basename(srcDir));
  // Slugify: skill manifests sometimes have a Title Case / spaced `name:`
  // (e.g. "Writing Hookify Rules"). Convert to a valid slug rather than
  // rejecting it — lowercase, spaces/underscores→dash, drop other chars.
  const name = rawName
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name || !NAME_RE.test(name)) {
    result.failed.push({ source, error: `Could not derive a valid skill name from "${rawName}"` });
    return;
  }
  const parsed = parseSkill(raw, name, srcDir, 'user');
  if (!parsed) {
    result.failed.push({ source, error: `SKILL.md for "${name}" missing description:` });
    return;
  }

  // Security scan before disk write. In a BULK install we never silently write a
  // flagged skill: dangerous always fails the item; suspicious needs force.
  const scan = scanSkillContent(await gatherSkillTextBulk(srcDir));
  if (scan.severity === 'dangerous') {
    result.failed.push({ source, error: `BLOCKED by security scan: ${scan.findings.map(f => f.rule).join(', ')}` });
    logger.warn('Skill blocked by security scan', { name, source, findings: scan.findings.map(f => f.rule) });
    return;
  }
  if (scan.severity === 'suspicious' && !force) {
    result.failed.push({ source, error: `Suspicious (use --force to install): ${scan.findings.map(f => f.rule).join(', ')}` });
    return;
  }

  const target = path.join(userSkillsDir(), name);
  try {
    await fs.stat(target);
    if (!force) {
      result.skipped.push({ name, reason: 'already installed (use force to overwrite)' });
      return;
    }
    await fs.rm(target, { recursive: true, force: true });
  } catch { /* not installed — good */ }

  await fs.mkdir(target, { recursive: true });
  await copyDir(srcDir, target);
  await stampSource(path.join(target, 'SKILL.md'), source);
  result.installed.push({ name, source });
  logger.info('Installed skill', { name, source });
}

/**
 * Install EVERYTHING reachable from a source.
 *  - gh:user/repo[@ref]      → multi-skill if it has SKILL.md files, else catalog
 *  - github URL              → same
 *  - ./local/dir             → multi-skill scan of the dir
 */
export async function installAll(
  source: string,
  opts: { force?: boolean; maxSkills?: number; onProgress?: (msg: string) => void } = {},
): Promise<BulkInstallResult> {
  const force = !!opts.force;
  const maxSkills = opts.maxSkills ?? 200;
  const progress = opts.onProgress ?? (() => {});
  const result: BulkInstallResult = { installed: [], skipped: [], failed: [] };

  const trimmed = source.trim();

  // Local directory → just scan it.
  if (trimmed.startsWith('./') || trimmed.startsWith('/') || trimmed.startsWith('../') || trimmed.startsWith('~')) {
    const dir = trimmed.replace(/^~/, os.homedir());
    const skillDirs = await findAllSkillDirs(dir);
    progress(`Found ${skillDirs.length} skill(s) locally`);
    for (const d of skillDirs.slice(0, maxSkills)) {
      await installOneSkillDir(d, `local:${d}`, force, result);
    }
    return result;
  }

  // Normalize a full GitHub web URL (…/blob/… or …/tree/…) into gh:u/r@ref#subpath
  // so a link to ONE skill installs only that skill, not the whole repo.
  const normalized = normalizeGithubSource(trimmed);

  // Parse gh:/github: → user/repo[@ref][#subpath]
  const spec = normalized.replace(/^(gh:|github:)/, '').replace(/^https?:\/\/github\.com\//, '');
  // Split off an optional #subpath first, then @ref.
  const [repoAndRef, subpath] = spec.split('#');
  const [repoPart, ref] = (repoAndRef ?? '').split('@');
  const parts = (repoPart ?? '').split('/');
  if (parts.length < 2) {
    result.failed.push({ source, error: `Bad source "${source}". Expected gh:user/repo or a github URL.` });
    return result;
  }
  const user = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/, '');

  progress(`Cloning ${user}/${repo}…`);
  const cloned = cloneRepo(user, repo, ref);
  if ('error' in cloned) {
    result.failed.push({ source, error: cloned.error });
    return result;
  }

  // If a subpath was given (from a blob/tree URL or an explicit #path), scope the
  // skill search to it — install just that skill, not every one in the repo.
  const searchRoot = subpath ? path.join(cloned.dir, subpath) : cloned.dir;

  // Multi-skill? Find all SKILL.md dirs (within the scoped root).
  const skillDirs = await findAllSkillDirs(searchRoot);
  if (skillDirs.length > 0) {
    progress(`Found ${skillDirs.length} skill(s) in ${user}/${repo}${subpath ? '/' + subpath : ''}`);
    for (const d of skillDirs.slice(0, maxSkills)) {
      await installOneSkillDir(d, `gh:${user}/${repo}`, force, result);
    }
    return result;
  }

  // No SKILL.md → treat as a link catalog. Parse README*.md for GitHub links.
  progress(`No SKILL.md found — treating ${user}/${repo} as a link catalog`);
  let catalogMd = '';
  for (const fname of ['README.md', 'readme.md', 'README.MD', 'Readme.md']) {
    try { catalogMd = await fs.readFile(path.join(cloned.dir, fname), 'utf-8'); break; } catch {}
  }
  if (!catalogMd) {
    result.failed.push({ source, error: `No SKILL.md and no README to parse in ${user}/${repo}` });
    return result;
  }

  const linkSpecs = parseGithubLinksFromMarkdown(catalogMd)
    .filter(s => !s.startsWith(`${user}/${repo}`)); // don't recurse into self
  progress(`Catalog lists ${linkSpecs.length} source repo(s); installing…`);

  // Dedup by repo (a repo may appear several times with different subpaths).
  const seenRepos = new Set<string>();
  for (const ls of linkSpecs) {
    if (result.installed.length >= maxSkills) break;
    // ls is "user/repo", "user/repo@ref", or "user/repo@ref#subpath"
    const [rp, rest] = ls.split('@');
    const refAndPath = rest ?? '';
    const [lref, subpath] = refAndPath.split('#');
    const repoKey = `${rp}@${lref ?? ''}#${subpath ?? ''}`;
    if (seenRepos.has(repoKey)) continue;
    seenRepos.add(repoKey);

    const [lu, lr] = (rp ?? '').split('/');
    if (!lu || !lr) continue;
    progress(`  → ${rp}${subpath ? '/' + subpath : ''}`);

    const sub = cloneRepo(lu, lr.replace(/\.git$/, ''), lref || undefined);
    if ('error' in sub) {
      result.failed.push({ source: ls, error: sub.error });
      continue;
    }
    // If a subpath was given, scope the search there; else scan whole repo.
    const scanRoot = subpath ? path.join(sub.dir, subpath) : sub.dir;
    let dirs: string[] = [];
    try { dirs = await findAllSkillDirs(scanRoot); } catch { dirs = []; }
    if (dirs.length === 0) {
      result.failed.push({ source: ls, error: `No SKILL.md found at ${rp}${subpath ? '/' + subpath : ''}` });
      continue;
    }
    for (const d of dirs.slice(0, maxSkills - result.installed.length)) {
      await installOneSkillDir(d, `gh:${rp}`, force, result);
    }
  }

  return result;
}

// ── small local copies of installer helpers (kept private to avoid circular deps) ──

function extractName(raw: string): string | null {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
  if (!fm) return null;
  const m = /^name\s*:\s*(.+)$/m.exec(fm[1]!);
  return m ? m[1]!.trim().replace(/^["']|["']$/g, '') : null;
}

async function copyDir(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) await copyDir(src, dst);
    else if (ent.isFile()) await fs.copyFile(src, dst);
  }
}

async function stampSource(skillFile: string, source: string): Promise<void> {
  try {
    const raw = await fs.readFile(skillFile, 'utf-8');
    if (/^source\s*:/m.test(raw)) return;
    if (/^---\s*\n/.test(raw)) {
      const out = raw.replace(/^---\s*\n/, `---\nsource: ${source}\n`);
      await fs.writeFile(skillFile, out);
    }
  } catch (e: any) {
    // Non-fatal: the skill is installed, but provenance stamping failed so it
    // will be missing its `source:`. Surface it instead of hiding it silently.
    logger.warn('Failed to stamp source provenance into skill', {
      name: path.basename(path.dirname(skillFile)),
      source,
      err: e?.message ?? String(e),
    });
  }
}

/** Concatenate scannable skill text for the security scan (bulk path). */
async function gatherSkillTextBulk(root: string): Promise<string> {
  const SCAN_EXT = new Set(['.md', '.markdown', '.txt', '.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.ps1', '.yaml', '.yml', '.json', '.toml', '.env']);
  const SKIP_DIR = new Set(['.git', 'node_modules', '.github', 'dist', 'build', '__pycache__', '.venv']);
  const MAX_FILE = 256 * 1024, MAX_TOTAL = 2 * 1024 * 1024;
  let total = 0; const chunks: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (total >= MAX_TOTAL) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) await walk(full); continue; }
      if (e.name !== 'SKILL.md' && !SCAN_EXT.has(path.extname(e.name).toLowerCase())) continue;
      try {
        const st = await fs.stat(full);
        if (st.size > MAX_FILE) continue;
        const text = await fs.readFile(full, 'utf-8');
        chunks.push(text); total += text.length;
      } catch { /* skip */ }
    }
  }
  await walk(root);
  return chunks.join('\n');
}
