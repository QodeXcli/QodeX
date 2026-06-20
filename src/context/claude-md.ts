import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';

const PROJECT_RULE_FILES = ['QODEX.md', 'CLAUDE.md', 'AGENTS.md', '.cursorrules', '.windsurfrules', 'AI.md'];

export async function loadProjectRules(cwd: string): Promise<{ content: string; sourcePath: string } | null> {
  // Walk up from cwd looking for project rule files
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;

  while (dir !== root) {
    for (const name of PROJECT_RULE_FILES) {
      const filePath = path.join(dir, name);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return { content: content.trim(), sourcePath: filePath };
      } catch (err: any) {
        // ENOENT just means this rule file isn't present here — keep walking.
        // Any other error (e.g. EACCES) means an EXISTING rule file failed to
        // read; surface it so the user's project rules aren't silently dropped.
        if (err?.code !== 'ENOENT') {
          logger.warn(`Failed to read project rule file ${filePath}: ${err?.message ?? err}`);
        }
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
    return { content: content.trim(), sourcePath: home };
  } catch {}

  return null;
}
