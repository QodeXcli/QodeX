/**
 * "Did you mean" suggestions for file-not-found errors.
 *
 * When the model targets a path that doesn't exist — often because it guessed
 * the wrong directory (e.g. looked in the backend folder for a frontend file) —
 * a bare "use ls" sends it into a long blind search. Instead we do a quick,
 * bounded scan for files sharing the same basename and surface them, so the
 * model can self-correct in one step.
 *
 * The scan is capped (breadth and depth) and skips heavy/ignored dirs so it
 * never becomes the slow path on a large repo.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.venv', 'venv', '__pycache__', '.qodex', 'staticfiles', '.cache',
]);

/**
 * Find files matching the basename of `target` anywhere under `root` (bounded).
 * Returns relative paths, closest matches first. Empty if none/timeout.
 */
export async function suggestSimilarPaths(
  root: string,
  target: string,
  opts: { maxResults?: number; maxVisited?: number } = {},
): Promise<string[]> {
  const maxResults = opts.maxResults ?? 4;
  const maxVisited = opts.maxVisited ?? 4000;
  const wantBase = path.basename(target).toLowerCase();
  if (!wantBase) return [];
  const wantStem = wantBase.replace(path.extname(wantBase), '');

  const hits: Array<{ rel: string; score: number }> = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (visited >= maxVisited || depth > 8 || hits.length >= maxResults * 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (visited >= maxVisited) return;
      visited++;
      if (e.name.startsWith('.') && e.name !== '.env') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(abs, depth + 1);
      } else {
        const base = e.name.toLowerCase();
        if (base === wantBase) {
          hits.push({ rel: path.relative(root, abs), score: 3 }); // exact basename
        } else if (base.replace(path.extname(base), '') === wantStem) {
          hits.push({ rel: path.relative(root, abs), score: 2 }); // same stem, diff ext
        }
      }
    }
  }

  await walk(root, 0);
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(h => h.rel);
}

/** Format a not-found message with suggestions appended (if any). */
export async function notFoundWithSuggestions(
  root: string,
  targetPath: string,
  prefix: string,
): Promise<string> {
  const suggestions = await suggestSimilarPaths(root, targetPath);
  if (suggestions.length === 0) return prefix;
  return `${prefix}\nFiles with that name exist elsewhere — did you mean one of these?\n${suggestions.map(s => `  ${s}`).join('\n')}`;
}
