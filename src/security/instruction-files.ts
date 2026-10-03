/**
 * Agent instruction files — the agent's standing orders. A prompt-injected page that
 * gets the agent to edit one of these persists the injection into every future session,
 * so writes to them need a human in EVERY approval mode, auto included:
 *
 *   - project instructions: QODEX.md, AGENTS.md, CLAUDE.md, GEMINI.md, AI.md, .cursorrules,
 *     .windsurfrules, .github/copilot-instructions.md, anything under .qodex/ (project
 *     config, skills, hooks, rules) and .cursor/rules/;
 *   - user-level: everything under ~/.qodex/skills, ~/.qodex/rules, ~/.qodex/hooks,
 *     ~/.qodex/mods (mods are code QodeX runs) and ~/.qodex/mods.json (which mods load,
 *     which project mods are trusted), ~/.qodex/QODEX.md / AGENTS.md / memory files;
 *   - session-scoped: the dirs this session loads mods from with --mod-dir / QODEX_MOD_DIRS
 *     (registered by the mods runtime). They are reloaded on save, so a write there runs as
 *     code at once — wherever the dir is, inside the project included.
 *
 * Path classification (pure apart from the session's mod dirs); the permission engine
 * decides what to do with it.
 */
import * as os from 'os';
import * as path from 'path';

/** Mod dirs of this session (absolute) → how many runtimes registered them. */
const sessionModDirs = new Map<string, number>();

/** The mods runtime loads (and hot-reloads) code from `dirs`: writes there ask. Returns the undo. */
export function registerModInstructionDirs(dirs: readonly string[]): () => void {
  const abs = [...new Set(dirs.map(d => path.resolve(d)))];
  for (const d of abs) sessionModDirs.set(d, (sessionModDirs.get(d) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const d of abs) {
      const n = (sessionModDirs.get(d) ?? 1) - 1;
      if (n <= 0) sessionModDirs.delete(d); else sessionModDirs.set(d, n);
    }
  };
}

function inOrAt(dir: string, abs: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const PROJECT_FILES = new Set([
  'qodex.md', 'agents.md', 'claude.md', 'gemini.md', 'ai.md', '.cursorrules', '.windsurfrules',
]);

const PROJECT_PATHS = [
  ['.qodex'],
  ['.cursor', 'rules'],
  ['.github', 'copilot-instructions.md'],
];

const USER_DIRS = ['skills', 'rules', 'hooks', 'memory', 'mods'];
const USER_FILES = new Set(['qodex.md', 'agents.md', 'memory.md', 'user.md', 'facts.md', 'soul.md', 'mods.json']);

export interface InstructionFileHit {
  /** Path relative to the project or ~/.qodex, for the prompt. */
  label: string;
  scope: 'project' | 'user';
}

/** Is `filePath` (resolved against cwd) an agent instruction file? PURE. */
export function instructionFileHit(filePath: string, cwd: string, home: string = os.homedir()): InstructionFileHit | null {
  if (!filePath) return null;
  const abs = path.resolve(cwd, filePath.startsWith('~/') ? path.join(home, filePath.slice(2)) : filePath);
  const qodexHome = path.join(home, '.qodex');

  for (const dir of sessionModDirs.keys()) {
    if (inOrAt(dir, abs)) {
      const rel = path.relative(cwd, abs);
      const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
      return { label: `${shown} (a --mod-dir mod: QodeX runs it)`, scope: 'user' };
    }
  }

  const relUser = path.relative(qodexHome, abs);
  if (relUser && !relUser.startsWith('..') && !path.isAbsolute(relUser)) {
    const parts = relUser.split(path.sep);
    const first = parts[0]!.toLowerCase();
    if (USER_DIRS.includes(first) || (parts.length === 1 && USER_FILES.has(first))) {
      return { label: `~/.qodex/${parts.join('/')}`, scope: 'user' };
    }
    return null; // other ~/.qodex state (sessions, browser, vault…) is Sentinel's business
  }

  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  const lower = parts.map(p => p.toLowerCase());
  if (parts.length === 1 && PROJECT_FILES.has(lower[0]!)) return { label: parts[0]!, scope: 'project' };
  for (const prefix of PROJECT_PATHS) {
    if (prefix.every((seg, i) => lower[i] === seg)) return { label: parts.join('/'), scope: 'project' };
  }
  return null;
}

/** Prompt text explaining why this write still asks. PURE. */
export function instructionFileReason(hit: InstructionFileHit): string {
  return `${hit.label} holds the agent's standing instructions — writes to it always need your OK (a prompt-injected page must not rewrite the agent's own rules).`;
}
