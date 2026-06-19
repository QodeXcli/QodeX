import * as path from 'path';

/**
 * When a tool is handed an ABSOLUTE path that resolves OUTSIDE the working directory
 * and that path doesn't exist, models sometimes hallucinated a generic project root
 * (e.g. /home/user/code/..., /tmp/...) and burned turns probing it. This appends a
 * one-line reminder of the real cwd to the error so the model self-corrects fast.
 * Returns '' for relative paths or paths inside cwd (no nudge needed).
 */
export function outsideCwdHint(givenPath: string, resolved: string, cwd: string): string {
  if (!path.isAbsolute(givenPath)) return '';
  const rel = path.relative(cwd, resolved);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (inside) return '';
  return ` NOTE: that is an absolute path OUTSIDE your working directory. You are in \`${cwd}\` — use paths relative to it (e.g. \`src/...\`), not invented roots like /home/user or /tmp.`;
}
