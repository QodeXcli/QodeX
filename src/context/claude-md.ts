import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';
import { getActiveConfig } from '../config/loader.js';

/** Project instruction files, in priority order (the first one found wins in 'first' mode). */
export const PROJECT_RULE_FILES = ['QODEX.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', 'AI.md'];

/**
 * How project instruction files load (config `context.projectInstructions`, `/instructions`):
 *  - 'first' (default): the first file found walking up from the cwd;
 *  - 'all': every one found in the nearest directory that has any, concatenated with a
 *    header per file (identical contents loaded once — e.g. CLAUDE.md symlinked to AGENTS.md).
 */
export type ProjectInstructionsMode = 'first' | 'all';

export interface ProjectRules {
  content: string;
  /** The (first) file the rules came from. */
  sourcePath: string;
  /** Every file merged into `content` ('all' mode); just `sourcePath` otherwise. */
  sources?: string[];
}

/** Session override from `/instructions all|first` (null = follow the config). */
let sessionMode: ProjectInstructionsMode | null = null;

export function setProjectInstructionsMode(mode: ProjectInstructionsMode | null): void {
  sessionMode = mode;
}

/** Session override, else config `context.projectInstructions`, else 'first'. */
export function getProjectInstructionsMode(): ProjectInstructionsMode {
  if (sessionMode) return sessionMode;
  try {
    const v = (getActiveConfig() as { context?: { projectInstructions?: unknown } } | null)?.context?.projectInstructions;
    return v === 'all' ? 'all' : 'first';
  } catch {
    return 'first';
  }
}

/** Read one rule file: its content, or null when absent. Unreadable files are logged, not fatal. */
async function readRuleFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    // ENOENT just means this rule file isn't present here — keep walking.
    // Any other error (e.g. EACCES) means an EXISTING rule file failed to
    // read; surface it so the user's project rules aren't silently dropped.
    if (err?.code !== 'ENOENT') {
      logger.warn(`Failed to read project rule file ${filePath}: ${err?.message ?? err}`);
    }
    return null;
  }
}

/** 'all' mode: the files of one directory merged with a header each; duplicates loaded once. PURE. */
export function mergeRuleFiles(files: Array<{ name: string; content: string }>): string {
  const kept: Array<{ names: string[]; content: string }> = [];
  for (const f of files) {
    const content = f.content.trim();
    if (!content) continue;
    const same = kept.find(k => k.content === content);
    if (same) same.names.push(f.name);
    else kept.push({ names: [f.name], content });
  }
  if (kept.length === 1) return kept[0]!.content;
  return kept
    .map(k => `## From ${k.names[0]}${k.names.length > 1 ? ` (same as ${k.names.slice(1).join(', ')})` : ''}\n\n${k.content}`)
    .join('\n\n');
}

export async function loadProjectRules(cwd: string, opts: { mode?: ProjectInstructionsMode } = {}): Promise<ProjectRules | null> {
  const mode = opts.mode ?? getProjectInstructionsMode();
  // Walk up from cwd looking for project rule files
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (mode === 'all') {
      const found: Array<{ name: string; path: string; content: string }> = [];
      for (const name of PROJECT_RULE_FILES) {
        const filePath = path.join(dir, name);
        const content = await readRuleFile(filePath);
        if (content !== null) found.push({ name, path: filePath, content });
      }
      if (found.length > 0) {
        return {
          content: mergeRuleFiles(found),
          sourcePath: found[0]!.path,
          sources: found.map(f => f.path),
        };
      }
    } else {
      for (const name of PROJECT_RULE_FILES) {
        const filePath = path.join(dir, name);
        const content = await readRuleFile(filePath);
        if (content !== null) return { content: content.trim(), sourcePath: filePath, sources: [filePath] };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Also check home directory for global rules
  try {
    const home = path.join(process.env.HOME ?? '', '.qodex', 'QODEX.md');
    const content = await fs.readFile(home, 'utf-8');
    return { content: content.trim(), sourcePath: home, sources: [home] };
  } catch {}

  return null;
}
