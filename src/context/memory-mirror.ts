/**
 * Markdown mirror of the agent's learned memory — the human-readable, git-able view of the facts
 * the DB holds.
 *
 * QodeX keeps facts in `~/.qodex/sessions.db` (structured, cwd-scoped, queryable). That's great for
 * the machine but opaque to a human — you can't open a file and read or edit what the agent learned.
 * This module mirrors those facts to plain markdown, in BOTH directions:
 *   - DB → MD (`exportMemory`): regenerated whenever a fact is added/forgotten, so the files always
 *     reflect the store. `~/.qodex/memory.md` (user facts) and `<cwd>/.qodex/MEMORY.md` (project facts).
 *   - MD → DB (`importMemory`): you edit a file by hand, then `import` pulls any NEW bullets into the
 *     DB (additive — to remove a fact use `/memory forget`, which re-exports). DB stays the source of
 *     truth; the markdown is a faithful, editable view. Curated rules still live in QODEX.md.
 *
 * The serialize/parse core is PURE so it's fully unit-tested without touching disk or the store.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getSessionStore } from '../session/store.js';

const COMMENT =
  '<!-- Agent-learned facts, mirrored from ~/.qodex/sessions.db. Edit freely, then run ' +
  '`qodex memory import` (or /memory import) to save changes back. Curated rules go in QODEX.md. -->';

/** Render facts as a markdown memory file (PURE). One fact per bullet; newlines folded to spaces. */
export function serializeMemory(facts: string[], title: string): string {
  const body = facts.length ? facts.map(f => `- ${f.replace(/\s*\n\s*/g, ' ').trim()}`).join('\n') : '_(none yet)_';
  return `# QodeX memory — ${title}\n${COMMENT}\n\n${body}\n`;
}

/** Extract the facts from a markdown memory file (PURE): bullet lines, skipping header/comment/blank. */
export function parseMemory(md: string): string[] {
  const out: string[] = [];
  for (const raw of md.split('\n')) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(raw);
    if (m && m[1] && m[1] !== '_(none yet)_') out.push(m[1].trim());
  }
  return out;
}

/** Where the two mirror files live for a given working directory. */
export function memoryPaths(cwd: string): { user: string; project: string } {
  return {
    user: path.join(os.homedir(), '.qodex', 'memory.md'),
    project: path.join(cwd, '.qodex', 'MEMORY.md'),
  };
}

function projectTitle(cwd: string): string {
  try { return getSessionStore().getProject(cwd)?.name || path.basename(cwd); }
  catch { return path.basename(cwd); }
}

/** DB → MD: regenerate both memory files from the store. Best-effort; never throws. */
export async function exportMemory(cwd: string): Promise<{ user: string; project: string }> {
  const paths = memoryPaths(cwd);
  try {
    const store = getSessionStore();
    const userFacts = store.getFactsByScope('user', cwd, 1000);
    const projFacts = store.getFactsByScope('project', cwd, 1000);
    await fs.mkdir(path.dirname(paths.user), { recursive: true }).catch(() => {});
    await fs.mkdir(path.dirname(paths.project), { recursive: true }).catch(() => {});
    await fs.writeFile(paths.user, serializeMemory(userFacts, 'user (global)'));
    await fs.writeFile(paths.project, serializeMemory(projFacts, projectTitle(cwd)));
  } catch { /* mirror is best-effort — a failed write never breaks a fact write */ }
  return paths;
}

/** MD → DB: add any bullet present in a mirror file but missing from the store. Returns the count
 *  added per scope. Additive only (removing a line won't delete a fact — use `/memory forget`). */
export async function importMemory(cwd: string): Promise<{ user: number; project: number }> {
  const store = getSessionStore();
  const paths = memoryPaths(cwd);
  const result = { user: 0, project: 0 };
  for (const scope of ['user', 'project'] as const) {
    const md = await fs.readFile(paths[scope], 'utf-8').catch(() => '');
    if (!md) continue;
    const inDb = new Set(store.getFactsByScope(scope, cwd, 5000));
    for (const fact of parseMemory(md)) {
      if (!inDb.has(fact)) { store.addFact('memory-import', cwd, fact, scope); result[scope]++; }
    }
  }
  if (result.user || result.project) await exportMemory(cwd); // re-render so files + DB match exactly
  return result;
}
