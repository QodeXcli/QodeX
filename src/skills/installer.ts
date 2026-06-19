/**
 * Skill installer — copies a skill bundle into ~/.qodex/skills/<name>/.
 *
 * Sources:
 *   ./path                  local directory (must contain SKILL.md, or skills/<name>/SKILL.md)
 *   /abs/path               same — accepted as absolute path
 *   ./file.tgz | .tar.gz    tarball — extracted, then treated as local dir
 *   gh:user/repo[@ref]      shallow git clone (requires `git` on PATH)
 *   github:user/repo[@ref]  alias for gh:
 *   npm:<pkg>[@ver]         npm pack + extract (requires `npm` on PATH)
 *   <bare-name>             registry placeholder — surfaces a friendly error
 *
 * The installer is intentionally minimal: every external scheme shells out to a
 * standard tool the user already has (git, npm, tar). Network errors surface
 * verbatim so the user can diagnose.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { userSkillsDir, parseSkill } from './loader.js';
import { scanSkillContent, formatScanReport } from './security-scan.js';

export interface InstallResult {
  name: string;
  installedTo: string;
  source: string;
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export async function installSkill(source: string, opts: { force?: boolean } = {}): Promise<InstallResult> {
  const trimmed = source.trim();
  if (!trimmed) throw new Error('Empty skill source.');

  if (trimmed.startsWith('gh:') || trimmed.startsWith('github:')) {
    return installFromGithub(trimmed.replace(/^(gh:|github:)/, ''), trimmed, opts);
  }
  if (trimmed.startsWith('npm:')) {
    return installFromNpm(trimmed.slice(4), trimmed, opts);
  }
  if (trimmed.startsWith('./') || trimmed.startsWith('/') || trimmed.startsWith('../') || trimmed.startsWith('~')) {
    return installFromLocal(expandHome(trimmed), trimmed, opts);
  }
  // Treat any path-like input that exists as local. Otherwise it's a bare name.
  const maybePath = path.resolve(process.cwd(), trimmed);
  try {
    await fs.stat(maybePath);
    return installFromLocal(maybePath, trimmed, opts);
  } catch {}
  throw new Error(
    `Don't know how to install "${trimmed}".\n` +
    `Use one of:\n` +
    `  qodex skill install ./path/to/skill-dir\n` +
    `  qodex skill install path/to/skill.tgz\n` +
    `  qodex skill install gh:user/repo[@ref]\n` +
    `  qodex skill install npm:@scope/skill-pkg\n\n` +
    `(A public QodeX skill registry is planned. Until then, install by URL/path.)`,
  );
}

async function installFromLocal(srcPath: string, originalSource: string, opts: { force?: boolean }): Promise<InstallResult> {
  const stat = await fs.stat(srcPath);
  if (stat.isFile()) {
    if (/\.tgz$|\.tar\.gz$|\.tar$/i.test(srcPath)) {
      const tmp = await mkdtempIn(os.tmpdir(), 'qodex-skill-tgz-');
      runOrThrow('tar', ['-xzf', srcPath, '-C', tmp], 'extract tarball');
      const extracted = await findSkillRoot(tmp);
      return copyInto(extracted, originalSource, opts);
    }
    throw new Error(`Expected a directory, .tgz, or .tar.gz — got: ${srcPath}`);
  }
  if (!stat.isDirectory()) throw new Error(`Source is not a file or directory: ${srcPath}`);
  const root = await findSkillRoot(srcPath);
  return copyInto(root, originalSource, opts);
}

async function installFromGithub(spec: string, originalSource: string, opts: { force?: boolean }): Promise<InstallResult> {
  // spec is like "user/repo" or "user/repo@ref"
  const [repoPart, ref] = spec.split('@');
  if (!repoPart || !/^[^/]+\/[^/]+$/.test(repoPart)) {
    throw new Error(`Bad gh: spec "${spec}". Expected user/repo[@ref].`);
  }
  const tmp = await mkdtempIn(os.tmpdir(), 'qodex-skill-gh-');
  const url = `https://github.com/${repoPart}.git`;
  const args = ['clone', '--depth', '1', url, tmp];
  if (ref) {
    args.splice(2, 0, '--branch', ref);
  }
  runOrThrow('git', args, `clone ${url}`);
  const root = await findSkillRoot(tmp);
  return copyInto(root, originalSource, opts);
}

async function installFromNpm(spec: string, originalSource: string, opts: { force?: boolean }): Promise<InstallResult> {
  const tmp = await mkdtempIn(os.tmpdir(), 'qodex-skill-npm-');
  // `npm pack` writes the tgz to cwd, so cd into tmp first
  const packResult = spawnSync('npm', ['pack', spec], { cwd: tmp, encoding: 'utf-8' });
  if (packResult.status !== 0) {
    throw new Error(`npm pack ${spec} failed: ${packResult.stderr || packResult.stdout || 'unknown error'}`);
  }
  const tgzName = packResult.stdout.trim().split('\n').filter(Boolean).pop();
  if (!tgzName) throw new Error(`npm pack produced no tarball for ${spec}.`);
  const tgzPath = path.join(tmp, tgzName);
  runOrThrow('tar', ['-xzf', tgzPath, '-C', tmp], 'extract npm tarball');
  // npm tarballs extract under a "package/" subdir
  const pkgDir = path.join(tmp, 'package');
  let root: string;
  try {
    await fs.stat(pkgDir);
    root = await findSkillRoot(pkgDir);
  } catch {
    root = await findSkillRoot(tmp);
  }
  return copyInto(root, originalSource, opts);
}

/** Walk a freshly extracted source looking for a SKILL.md root. */
async function findSkillRoot(src: string): Promise<string> {
  // Direct hit: src/SKILL.md
  try {
    await fs.stat(path.join(src, 'SKILL.md'));
    return src;
  } catch {}

  // Single child wrapper (common with tar extracts and git clones)
  const entries = await fs.readdir(src, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
  if (dirs.length === 1) {
    const inner = path.join(src, dirs[0]!.name);
    try {
      await fs.stat(path.join(inner, 'SKILL.md'));
      return inner;
    } catch {}
  }

  // skills/<name>/SKILL.md layout (multi-skill repos pick the first)
  const skillsParent = path.join(src, 'skills');
  try {
    const sub = await fs.readdir(skillsParent, { withFileTypes: true });
    for (const ent of sub) {
      if (!ent.isDirectory()) continue;
      const cand = path.join(skillsParent, ent.name);
      try {
        await fs.stat(path.join(cand, 'SKILL.md'));
        return cand;
      } catch {}
    }
  } catch {}

  throw new Error(`Couldn't find a SKILL.md in ${src}. Skills must ship a top-level SKILL.md or skills/<name>/SKILL.md.`);
}

async function copyInto(srcRoot: string, originalSource: string, opts: { force?: boolean }): Promise<InstallResult> {
  const raw = await fs.readFile(path.join(srcRoot, 'SKILL.md'), 'utf-8');
  // Parse to get the canonical name. If frontmatter has `name:`, prefer that;
  // otherwise fall back to the directory name.
  const fmName = extractFrontmatterName(raw);
  const dirName = path.basename(srcRoot);
  const name = (fmName ?? dirName).toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error(`Skill name "${name}" is invalid. Names must match /^[a-z][a-z0-9-]*$/.`);
  }
  // Validate it parses cleanly before we commit
  const parsed = parseSkill(raw, name, srcRoot, 'user');
  if (!parsed) throw new Error('SKILL.md is missing a `description:` field.');

  // Security scan BEFORE anything touches disk. A skill is instructions the agent
  // reads and acts on, so a malicious one is close to running untrusted code:
  // prompt injection, secret exfiltration, destructive shell, hidden unicode.
  // `dangerous` findings hard-block even with --force; `suspicious` can be
  // overridden with --force after the user reviews the report.
  const scanText = await gatherSkillText(srcRoot);
  const scan = scanSkillContent(scanText);
  if (scan.severity !== 'clean') {
    const report = formatScanReport(scan, name);
    if (scan.severity === 'dangerous') {
      throw new Error(
        `${report}\n\nInstall blocked. Dangerous findings cannot be overridden with --force. ` +
        `Inspect the skill source manually before trusting it.`,
      );
    }
    if (!opts.force) {
      throw new Error(
        `${report}\n\nInstall paused. Review the skill, then re-run with --force to install anyway.`,
      );
    }
    // suspicious + force → proceed, but the report was shown above by the caller path.
  }

  const target = path.join(userSkillsDir(), name);
  try {
    await fs.stat(target);
    if (!opts.force) {
      throw new Error(`Skill "${name}" is already installed at ${target}. Pass --force to overwrite, or use \`qodex skill remove ${name}\` first.`);
    }
    await fs.rm(target, { recursive: true, force: true });
  } catch (e: any) {
    // Not-installed is the happy path
    if (e?.code !== 'ENOENT' && !String(e?.message ?? '').includes('already installed')) {
      // re-throw if it's the "already installed" error so the caller sees it
      if (String(e?.message ?? '').startsWith('Skill "')) throw e;
    }
  }
  await fs.mkdir(target, { recursive: true });
  await copyDir(srcRoot, target);

  // Stamp provenance into SKILL.md if not already present
  await stampSource(path.join(target, 'SKILL.md'), originalSource);

  return { name, installedTo: target, source: originalSource };
}

async function copyDir(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) {
      await copyDir(src, dst);
    } else if (ent.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}

async function stampSource(skillFile: string, source: string): Promise<void> {
  const raw = await fs.readFile(skillFile, 'utf-8');
  if (/^source\s*:/m.test(raw)) return;
  // Inject `source:` inside the existing frontmatter block, just before `---`.
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return;
  const newFm = (m[1] ?? '').trimEnd() + `\nsource: ${source}\n`;
  const next = `---\n${newFm}---\n${m[2] ?? ''}`;
  await fs.writeFile(skillFile, next);
}

export async function removeSkill(name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`Invalid skill name "${name}".`);
  const target = path.join(userSkillsDir(), name);
  try {
    await fs.stat(target);
  } catch {
    throw new Error(`Skill "${name}" is not installed.`);
  }
  await fs.rm(target, { recursive: true, force: true });
}

function mkdtempIn(dir: string, prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(dir, prefix));
}

function runOrThrow(cmd: string, args: string[], stage: string): void {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`Failed to ${stage}: ${cmd} ${args.join(' ')}\n${res.stderr || res.stdout || `(exit ${res.status})`}`);
  }
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') return path.join(os.homedir(), p.slice(1));
  return path.resolve(process.cwd(), p);
}

function extractFrontmatterName(raw: string): string | undefined {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  const nameLine = (m[1] ?? '').split('\n').find(l => /^name\s*:/.test(l));
  if (!nameLine) return undefined;
  return nameLine.replace(/^name\s*:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Concatenate the skill's scannable text — SKILL.md plus any support files whose
 * content the agent might read or execute (.md/.txt/.sh/.bash/.zsh/.py/.js/.ts/.rb/
 * .pl/.ps1/.yaml/.yml/.json). Binary and large files are skipped; total is capped
 * so a giant repo can't blow up memory. Best-effort: unreadable files are ignored.
 */
async function gatherSkillText(root: string): Promise<string> {
  const SCAN_EXT = new Set([
    '.md', '.markdown', '.txt', '.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.mjs',
    '.cjs', '.ts', '.rb', '.pl', '.ps1', '.yaml', '.yml', '.json', '.toml', '.env',
  ]);
  const MAX_FILE = 256 * 1024;     // 256KB per file
  const MAX_TOTAL = 2 * 1024 * 1024; // 2MB overall
  const SKIP_DIR = new Set(['.git', 'node_modules', '.github', 'dist', 'build', '__pycache__', '.venv']);
  let total = 0;
  const chunks: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (total >= MAX_TOTAL) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) await walk(full);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      // SKILL.md has no "code" ext but is always scanned; otherwise gate by ext.
      if (e.name !== 'SKILL.md' && !SCAN_EXT.has(ext)) continue;
      try {
        const stat = await fs.stat(full);
        if (stat.size > MAX_FILE) continue;
        const text = await fs.readFile(full, 'utf-8');
        chunks.push(`\n# ── ${path.relative(root, full)} ──\n${text}`);
        total += text.length;
      } catch { /* skip unreadable */ }
    }
  }

  await walk(root);
  return chunks.join('\n');
}
