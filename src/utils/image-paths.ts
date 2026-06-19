/**
 * Detect image file paths inside a user message so QodeX can route them to vision.
 *
 * Terminal users paste paths with backslash-escaped spaces, e.g.
 *   /Users/me/Desktop/Screenshot\ 2026-05-22\ at\ 10.56.21.png
 * We match those, un-escape them, resolve against cwd, and keep only paths that exist.
 *
 * `annotateImagePrompt` appends a short directive naming the resolved absolute path(s)
 * so the agent reliably calls `vision_analyze` (which runs on the configured vision role)
 * instead of guessing or claiming it can't see images.
 */

import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'];

// A path token = runs of (non-space, non-backslash) OR (backslash + any char, i.e. an
// escape like "\ "), ending in an image extension, at a word/space boundary.
const IMAGE_PATH_RE = new RegExp(
  `((?:[^\\s\\\\]|\\\\.)+\\.(?:${IMAGE_EXT.join('|')}))(?=\\s|$|["'\\)])`,
  'gi',
);

function unescape(token: string): string {
  return token.replace(/\\(.)/g, '$1'); // "\ " -> " ", "\(" -> "(", etc.
}

function resolvePath(token: string, cwd: string): string {
  let p = unescape(token).trim();
  if (p.startsWith('~/') || p === '~') p = path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/** Distinct, existing image file paths referenced in `text` (resolved absolute). */
export function findImagePaths(text: string, cwd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(IMAGE_PATH_RE)) {
    const abs = resolvePath(m[1]!, cwd);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      if (fsSync.statSync(abs).isFile()) out.push(abs);
    } catch { /* not a real file — ignore (e.g. "logo.png" mentioned in prose) */ }
  }
  return out;
}

/**
 * If `text` references existing image file(s), append a directive telling the agent to
 * inspect them with `vision_analyze`. Returns `text` unchanged when none are found.
 */
export function annotateImagePrompt(text: string, cwd: string): string {
  const images = findImagePaths(text, cwd);
  if (images.length === 0) return text;
  const list = images.map(p => `  - ${p}`).join('\n');
  const barePathOnly = images.length === 1 && unescape(text.trim()) === images[0];
  const ask = barePathOnly ? 'Describe what it shows and anything notable.' : 'Use it to answer the request above.';
  return (
    `${text}\n\n` +
    `[QodeX detected image file(s) on disk. Call the \`vision_analyze\` tool on the EXACT ` +
    `path(s) below (it runs on the vision model) — do not say you can't see images. ${ask}\n` +
    `${list}\n]`
  );
}

// A path-like token: runs of (non-space, non-backslash) OR (backslash + any char). Used to
// pick candidate paths out of a pasted/dropped string without splitting on escaped spaces.
const PATH_TOKEN_RE = /(?:[^\s\\]|\\.)+/g;

/** Looks enough like a path to bother stat-ing (avoids treating prose words as paths). */
function looksLikePathToken(tok: string): boolean {
  const t = unescape(tok).trim().replace(/^['"]|['"]$/g, '');
  return t.includes('/') || t.startsWith('~') || t.startsWith('.') || path.isAbsolute(t);
}

export interface FsPath { abs: string; kind: 'dir' | 'file'; name: string; }

/**
 * Split a pasted/dropped burst into the filesystem paths it contains AND the leftover text.
 * Drag-drop frequently pastes a path right next to whatever the user typed ("add breadcrumbs to
 * <path>"), so we must NOT throw the instruction away when we lift the path out into a chip.
 * Returns the existing file/dir paths plus the remaining text with those path tokens removed.
 * Pure.
 */
export function splitPathsAndText(text: string, cwd: string): { paths: FsPath[]; text: string } {
  const paths: FsPath[] = [];
  const seen = new Set<string>();
  const rawPathTokens: string[] = [];
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    const tok = m[0]!;
    if (!looksLikePathToken(tok)) continue;
    const cleaned = tok.replace(/^['"]|['"]$/g, '');
    const abs = resolvePath(cleaned, cwd);
    if (seen.has(abs)) continue;
    try {
      const st = fsSync.statSync(abs);
      const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
      if (!kind) continue;
      seen.add(abs);
      paths.push({ abs, kind, name: path.basename(abs) });
      rawPathTokens.push(tok);
    } catch { /* doesn't exist — not a path */ }
  }
  let remainder = text;
  for (const t of rawPathTokens) remainder = remainder.replace(t, ' ');
  remainder = remainder.replace(/\s+/g, ' ').trim();
  return { paths, text: remainder };
}

/**
 * Existing filesystem paths (files OR directories) referenced in `text`, resolved absolute.
 * This is how a dragged-in folder/file becomes a real attachment instead of a generic "Pasted
 * 1 line" blob. We only keep tokens that (a) look path-like and (b) actually exist on disk, so
 * ordinary prose words can't be mistaken for paths. Images are handled separately.
 */
export function findFsPaths(text: string, cwd: string): FsPath[] {
  return splitPathsAndText(text, cwd).paths;
}
