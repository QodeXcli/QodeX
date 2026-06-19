/**
 * Custom slash commands let users (and projects) define their own /commands by dropping
 * Markdown files into `.qodex/commands/` directories. The Markdown file consists of an
 * optional YAML frontmatter block followed by a prompt template:
 *
 *   ---
 *   description: Fix lint errors in a file
 *   argument-hint: <file-path>
 *   allowed-tools:
 *     - read_file
 *     - edit_file
 *     - bash
 *   model: claude-sonnet-4
 *   mode: normal
 *   ---
 *   Please fix any lint errors in {{ARGUMENTS}}. First run the linter, then make
 *   minimal edits. Report what was changed.
 *
 * Discovery (project overrides user):
 *   - ~/.qodex/commands/*.md          (user-global)
 *   - <project>/.qodex/commands/*.md  (project-specific, takes precedence)
 *
 * The frontmatter parser is intentionally tiny — we want zero dependencies and we only
 * accept the small fixed schema documented here. Unknown keys are silently ignored.
 * Arrays are accepted in inline `[a, b]` form or YAML multiline form with `  - item`.
 *
 * Template interpolation tokens:
 *   {{ARGUMENTS}}  → everything after the command name
 *   {{ARG:N}}      → the Nth positional arg (0-indexed)
 *   {{CWD}}        → current working directory
 *   {{DATE}}       → ISO date (YYYY-MM-DD)
 *   {{TIME}}       → HH:MM:SS local time
 *
 * Security note: the template body is INSERTED INTO THE PROMPT, not evaluated as code.
 * It cannot execute arbitrary shell — that's what lifecycle hooks are for. The allowed-tools
 * field restricts which tools the agent loop will expose for this one execution.
 */

import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { logger } from '../utils/logger.js';
import { claudeCodeCommandDirs } from '../integrations/claude-plugins.js';

export interface CustomCommandSpec {
  /** Command name (filename without `.md`). */
  name: string;
  /** Absolute path of the source file. */
  filePath: string;
  /** Where the file was found. project overrides user when names collide. 'plugin' = imported from a Claude Code plugin / .claude dir. */
  origin: 'project' | 'user' | 'plugin';
  /** One-line description shown in /help and /commands. */
  description?: string;
  /** Hint shown next to the name to indicate expected args. */
  argumentHint?: string;
  /** If present, restricts the agent to ONLY these tools for this command's run. */
  allowedTools?: string[];
  /** Override the routed model for this run. */
  model?: string;
  /** Override the agent execution mode. */
  mode?: 'plan' | 'normal';
  /** Raw template body (what gets fed to the model after interpolation). */
  template: string;
}

const VALID_MODES: Set<string> = new Set(['plan', 'normal']);

/** Inspect both discovery dirs and return the merged command map. Project wins on collisions. */
export async function loadCustomCommands(cwd: string): Promise<Map<string, CustomCommandSpec>> {
  const map = new Map<string, CustomCommandSpec>();
  // Claude Code commands first (lowest precedence) so a user's own QodeX command of
  // the same name wins (later entries overwrite earlier ones in the map).
  const claudeDirs = (await claudeCodeCommandDirs(cwd)).map(d => ({ dir: d.dir, origin: 'plugin' as const }));
  const dirs: Array<{ dir: string; origin: 'project' | 'user' | 'plugin' }> = [
    ...claudeDirs,
    { dir: path.join(os.homedir(), '.qodex', 'commands'), origin: 'user' },
    { dir: path.join(cwd, '.qodex', 'commands'), origin: 'project' },
  ];
  for (const { dir, origin } of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const name = ent.name.slice(0, -3);
      if (!/^[a-zA-Z][\w-]*$/.test(name)) {
        logger.debug('Skipping custom command with invalid name', { file: ent.name });
        continue;
      }
      const filePath = path.join(dir, ent.name);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const spec = parseSpec(raw, name, filePath, origin);
        map.set(name, spec);
      } catch (e: any) {
        logger.warn('Failed to load custom command', { file: filePath, err: e.message });
      }
    }
  }
  return map;
}

/** Parse a Markdown file into a CustomCommandSpec. */
export function parseSpec(
  raw: string,
  name: string,
  filePath: string,
  origin: 'project' | 'user' | 'plugin',
): CustomCommandSpec {
  let description: string | undefined;
  let argumentHint: string | undefined;
  let allowedTools: string[] | undefined;
  let model: string | undefined;
  let mode: 'plan' | 'normal' | undefined;
  let body = raw;

  // Frontmatter must be at the very top, delimited by --- on its own line.
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    const fm = fmMatch[1] ?? '';
    body = fmMatch[2] ?? '';
    const fmLines = fm.split('\n');
    let i = 0;
    while (i < fmLines.length) {
      const line = fmLines[i]!;
      // Skip empty/comment lines
      if (/^\s*(#.*)?$/.test(line)) { i++; continue; }
      const m = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1]!.toLowerCase();
      const rawValue = m[2]!.trim();

      let value: string | string[];
      if (rawValue === '') {
        // Look ahead for `  - item` lines (YAML multiline list form)
        const items: string[] = [];
        i++;
        while (i < fmLines.length && /^\s+-\s+/.test(fmLines[i]!)) {
          items.push(stripQuotes(fmLines[i]!.replace(/^\s+-\s+/, '').trim()));
          i++;
        }
        value = items;
      } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        // Inline array
        value = rawValue
          .slice(1, -1)
          .split(',')
          .map(s => stripQuotes(s.trim()))
          .filter(Boolean);
        i++;
      } else {
        value = stripQuotes(rawValue);
        i++;
      }

      // Apply the key. Validate types loosely.
      switch (key) {
        case 'description':
          if (typeof value === 'string') description = value;
          break;
        case 'argument-hint':
        case 'argument_hint':
          if (typeof value === 'string') argumentHint = value;
          break;
        case 'allowed-tools':
        case 'allowed_tools':
          if (Array.isArray(value)) allowedTools = value;
          break;
        case 'model':
          if (typeof value === 'string') model = value;
          break;
        case 'mode':
          if (typeof value === 'string' && VALID_MODES.has(value)) {
            mode = value as 'plan' | 'normal';
          }
          break;
      }
    }
  }

  return {
    name,
    filePath,
    origin,
    description,
    argumentHint,
    allowedTools,
    model,
    mode,
    template: body.trim(),
  };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Interpolate the template body with the user-supplied args + builtin tokens. */
export function renderTemplate(template: string, args: string, ctx: { cwd: string }): string {
  const positionals = args.length > 0 ? args.split(/\s+/).filter(Boolean) : [];
  const now = new Date();
  return template
    .replace(/\{\{\s*ARGUMENTS\s*\}\}/g, args)
    .replace(/\{\{\s*ARG:(\d+)\s*\}\}/g, (_, idx) => positionals[parseInt(idx, 10)] ?? '')
    .replace(/\{\{\s*CWD\s*\}\}/g, ctx.cwd)
    .replace(/\{\{\s*DATE\s*\}\}/g, now.toISOString().slice(0, 10))
    .replace(/\{\{\s*TIME\s*\}\}/g, now.toTimeString().slice(0, 8));
}
