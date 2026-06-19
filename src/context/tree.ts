import { promises as fs } from 'fs';
import * as path from 'path';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'target', 'vendor', '.gradle', '.dart_tool',
  '.venv', 'venv', 'env',
  'coverage', '.nyc_output',
  '.DS_Store', '.qodex',
]);

const IGNORED_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.gitignore', '.npmignore',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'go.sum',
]);

/**
 * Topic → folder-name patterns. When the user prompt mentions one of these topics, the
 * matching folders are RANKED FIRST and given more depth. Other folders still appear
 * but get pruned more aggressively. Bidirectional: a folder named "components" weights
 * UP for "ui" / "component" / "style" / etc.
 *
 * Calibrated for the project types we actually see in QodeX sessions: web apps,
 * WordPress plugins, Python services, CLI tools.
 */
const TOPIC_FOLDER_HINTS: Array<{ keywords: string[]; folders: string[] }> = [
  {
    keywords: ['ui', 'frontend', 'component', 'style', 'css', 'theme', 'layout', 'page', 'view', 'jsx', 'tsx', 'react', 'vue'],
    folders: ['components', 'ui', 'styles', 'css', 'scss', 'views', 'pages', 'layouts', 'templates', 'assets', 'public', 'static', 'client', 'frontend', 'web'],
  },
  {
    keywords: ['api', 'backend', 'server', 'endpoint', 'route', 'controller', 'handler'],
    folders: ['api', 'server', 'backend', 'routes', 'controllers', 'handlers', 'services', 'app'],
  },
  {
    keywords: ['db', 'database', 'migration', 'schema', 'model', 'query', 'sql', 'orm'],
    folders: ['models', 'migrations', 'db', 'database', 'schema', 'sql', 'entities'],
  },
  {
    keywords: ['test', 'spec', 'unit', 'integration', 'e2e', 'jest', 'vitest', 'pytest'],
    folders: ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e'],
  },
  {
    keywords: ['config', 'settings', 'env', 'deploy', 'docker', 'kubernetes', 'k8s', 'ci', 'cd', 'pipeline'],
    folders: ['config', 'configs', 'deploy', 'deployment', 'infra', 'infrastructure', 'k8s', '.github', 'docker'],
  },
  {
    keywords: ['doc', 'docs', 'readme', 'guide', 'manual', 'tutorial'],
    folders: ['docs', 'documentation', 'examples', 'demo'],
  },
  {
    keywords: ['plugin', 'wp', 'wordpress', 'theme', 'php'],
    folders: ['wp-content', 'plugins', 'themes', 'includes', 'admin'],
  },
];

export interface TreeOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxBytes?: number;
  /**
   * Optional user-prompt context. If present, the tree is weighted: folders matching
   * the inferred topic are kept full-depth, others may be summarised. This is the
   * "Semantic Pruning" approach — without a pre-pass LLM call.
   */
  userPromptHint?: string;
}

interface TreeContext {
  maxDepth: number;
  maxEntries: number;
  maxBytes: number;
  /** Folders to keep at full depth. Empty = no weighting active. */
  relevantFolders: Set<string>;
  /** Whether ANY weighting is active (i.e. user prompt hint matched at least one topic). */
  hasWeighting: boolean;
  entryCount: number;
  byteCount: number;
  truncated: boolean;
  lines: string[];
}

/** Derive the relevant-folder set from the user's prompt. */
function inferRelevantFolders(promptHint: string | undefined): Set<string> {
  if (!promptHint) return new Set();
  const lower = promptHint.toLowerCase();
  const folders = new Set<string>();
  for (const { keywords, folders: f } of TOPIC_FOLDER_HINTS) {
    const hit = keywords.some(kw => {
      // Word-boundary match on each side so "api" matches "api/" but not "rapid"
      const re = new RegExp(`(^|[^a-z])${kw}([^a-z]|$)`);
      return re.test(lower);
    });
    if (hit) for (const folder of f) folders.add(folder);
  }
  return folders;
}

export async function buildDirectoryTree(
  rootDir: string,
  options: TreeOptions = {},
): Promise<string> {
  const ctx: TreeContext = {
    maxDepth: options.maxDepth ?? 3,
    maxEntries: options.maxEntries ?? 200,
    maxBytes: options.maxBytes ?? 4000,
    relevantFolders: inferRelevantFolders(options.userPromptHint),
    hasWeighting: false,
    entryCount: 0,
    byteCount: 0,
    truncated: false,
    lines: [path.basename(rootDir) + '/'],
  };
  ctx.hasWeighting = ctx.relevantFolders.size > 0;
  ctx.byteCount = ctx.lines[0]!.length;

  await walk(rootDir, 1, '', ctx);

  if (ctx.hasWeighting) {
    ctx.lines.push('');
    ctx.lines.push(`(tree weighted for query: kept ${[...ctx.relevantFolders].slice(0, 6).join('/')}; other folders summarised)`);
  }

  return ctx.lines.join('\n');
}

/** Whether a directory should be EXPANDED (deep walk) vs SUMMARISED (one-line count). */
function shouldExpandDir(name: string, ctx: TreeContext): boolean {
  if (!ctx.hasWeighting) return true; // no weighting → expand everything (legacy behaviour)
  // Always expand if name matches the relevant set OR is a generic source folder
  if (ctx.relevantFolders.has(name)) return true;
  // src/lib/internal/core — usually generic, expand by default
  if (['src', 'lib', 'internal', 'core', 'common', 'shared'].includes(name)) return true;
  return false;
}

async function walk(dir: string, depth: number, prefix: string, ctx: TreeContext): Promise<void> {
  if (depth > ctx.maxDepth || ctx.entryCount >= ctx.maxEntries || ctx.truncated) return;

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Filter ignored + hidden (except .github which is informative)
  entries = entries
    .filter(e => {
      if (IGNORED_DIRS.has(e.name) || IGNORED_FILES.has(e.name)) return false;
      if (e.name.startsWith('.') && e.name !== '.github') return false;
      return true;
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  for (let i = 0; i < entries.length; i++) {
    if (ctx.entryCount >= ctx.maxEntries || ctx.truncated) {
      pushLine(prefix + '... (truncated)', ctx);
      return;
    }

    const entry = entries[i]!;
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');

    if (entry.isDirectory()) {
      const expand = depth >= ctx.maxDepth ? false : shouldExpandDir(entry.name, ctx);
      if (!expand) {
        // Summarise: name + child count + truncation marker
        const summary = await summariseDir(path.join(dir, entry.name));
        pushLine(prefix + connector + entry.name + '/  ' + summary, ctx);
      } else {
        pushLine(prefix + connector + entry.name + '/', ctx);
        await walk(path.join(dir, entry.name), depth + 1, childPrefix, ctx);
      }
    } else {
      pushLine(prefix + connector + entry.name, ctx);
    }

    if (ctx.byteCount > ctx.maxBytes) {
      pushLine(prefix + '... (size limit reached)', ctx);
      ctx.truncated = true;
      return;
    }
  }
}

/** Cheap one-line summary of a directory: `(N items)`. Best-effort; failure → empty. */
async function summariseDir(dir: string): Promise<string> {
  try {
    const items = await fs.readdir(dir);
    const visible = items.filter(n => !IGNORED_DIRS.has(n) && !IGNORED_FILES.has(n) && !n.startsWith('.'));
    return `(${visible.length} item${visible.length === 1 ? '' : 's'})`;
  } catch {
    return '';
  }
}

function pushLine(line: string, ctx: TreeContext): void {
  ctx.lines.push(line);
  ctx.byteCount += line.length + 1; // +1 for newline
  ctx.entryCount += 1;
}

export async function getGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const headPath = path.join(cwd, '.git', 'HEAD');
    const head = await fs.readFile(headPath, 'utf-8');
    const m = head.match(/ref:\s*refs\/heads\/(.+)/);
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}
