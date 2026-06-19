import { promises as fs } from 'fs';
import * as path from 'path';

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
      } catch {}
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
