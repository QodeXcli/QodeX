/**
 * Agent instruction files — the agent's standing orders. A prompt-injected page that
 * gets the agent to edit one of these persists the injection into every future session,
 * so writes to them need a human in EVERY approval mode, auto included:
 *
 *   - project instructions: QODEX.md, AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules,
 *     .windsurfrules, .github/copilot-instructions.md, anything under .qodex/ (project
 *     config, skills, hooks, rules) and .cursor/rules/;
 *   - user-level: everything under ~/.qodex/skills, ~/.qodex/rules, ~/.qodex/hooks,
 *     ~/.qodex/QODEX.md / AGENTS.md / memory files.
 *
 * PURE path classification; the permission engine decides what to do with it.
 */
import * as os from 'os';
import * as path from 'path';

const PROJECT_FILES = new Set([
  'qodex.md', 'agents.md', 'claude.md', 'gemini.md', '.cursorrules', '.windsurfrules',
]);

const PROJECT_PATHS = [
  ['.qodex'],
  ['.cursor', 'rules'],
  ['.github', 'copilot-instructions.md'],
];

const USER_DIRS = ['skills', 'rules', 'hooks', 'memory'];
const USER_FILES = new Set(['qodex.md', 'agents.md', 'memory.md', 'user.md', 'facts.md', 'soul.md']);

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
