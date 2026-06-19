/**
 * Friendly, colourful display metadata for tool activity.
 *
 * Raw tool names (read_file, edit_symbol, code_graph_find_callers…) are accurate but
 * cold. While the agent works we want each action to read like a human verb — "Reading",
 * "Refactoring", "Type-checking" — in a colour that matches its category, so a glance at
 * the transcript tells you what kind of work is happening. This module is the single
 * source of truth for that mapping, kept pure (no Ink/React) so it's unit-testable and
 * reused by both the live activity line and the settled history entries.
 */

export interface ToolActivity {
  /** Present-continuous verb shown while the tool runs ("Reading", "Searching"). */
  verb: string;
  /** Single-width glyph prefix (kept ASCII-art-safe; no emoji width surprises). */
  icon: string;
  /** Hex colour for the category. */
  color: string;
  /** Coarse grouping, useful for tests / future theming. */
  category: string;
}

// Category palette — vivid but legible on a dark terminal.
const C = {
  read: '#22d3ee',        // cyan
  search: '#a855f7',      // violet
  write: '#34d399',       // green
  edit: '#fbbf24',        // amber
  shell: '#fb923c',       // orange
  web: '#3b82f6',         // blue
  browser: '#2dd4bf',     // teal
  vision: '#ec4899',      // pink
  git: '#f97316',         // orange-red
  diagnostics: '#f87171', // red
  delegate: '#818cf8',    // indigo
  plan: '#94a3b8',        // slate
  memory: '#c084fc',      // purple
  understand: '#38bdf8',  // sky
} as const;

function act(verb: string, icon: string, color: string, category: string): ToolActivity {
  return { verb, icon, color, category };
}

const EXACT: Record<string, ToolActivity> = {
  // Reading / inspecting
  read_file: act('Reading', '◇', C.read, 'read'),
  pdf_read: act('Reading PDF', '◇', C.read, 'read'),
  csv_read: act('Reading CSV', '◇', C.read, 'read'),
  xlsx_read: act('Reading sheet', '◇', C.read, 'read'),
  ls: act('Listing', '☰', C.read, 'read'),
  glob: act('Finding files', '⌕', C.read, 'read'),

  // Searching
  grep: act('Searching', '⌕', C.search, 'search'),
  semantic_search: act('Recalling', '✦', C.search, 'search'),

  // Writing
  write_file: act('Writing', '✎', C.write, 'write'),
  multi_file_edit: act('Writing files', '✎', C.write, 'write'),
  csv_write: act('Writing CSV', '✎', C.write, 'write'),

  // Editing
  edit_text: act('Editing', '✎', C.edit, 'edit'),
  edit_symbol: act('Refactoring', '✎', C.edit, 'edit'),
  multi_edit: act('Editing', '✎', C.edit, 'edit'),
  safe_rename: act('Renaming', '✎', C.edit, 'edit'),
  safe_delete_file: act('Removing', '✕', C.edit, 'edit'),

  // Shell / execution
  bash: act('Running', '⚡', C.shell, 'shell'),
  code_run: act('Executing', '⚡', C.shell, 'shell'),
  auto_fix: act('Verifying', '⚡', C.shell, 'shell'),

  // Diagnostics
  diagnostics: act('Type-checking', '⚙', C.diagnostics, 'diagnostics'),

  // Web
  web_search: act('Searching web', '◍', C.web, 'web'),
  web_fetch: act('Fetching', '◍', C.web, 'web'),
  http_request: act('Requesting', '◍', C.web, 'web'),
  network_check: act('Checking network', '◍', C.web, 'web'),

  // Vision
  vision_analyze: act('Looking', '◉', C.vision, 'vision'),

  // Delegation
  task: act('Delegating', '⇄', C.delegate, 'delegate'),

  // Planning / memory
  todo_write: act('Planning', '☰', C.plan, 'plan'),
  todo_read: act('Reviewing plan', '☰', C.plan, 'plan'),
  present_plan: act('Planning', '☰', C.plan, 'plan'),
  remember: act('Remembering', '✦', C.memory, 'memory'),
  recall: act('Recalling', '✦', C.memory, 'memory'),
  forget: act('Forgetting', '✦', C.memory, 'memory'),

  // Understanding / quality
  review_my_changes: act('Reviewing', '◈', C.understand, 'understand'),
  project_overview: act('Mapping project', '◈', C.understand, 'understand'),
  explain_codebase: act('Understanding', '◈', C.understand, 'understand'),
  suggest_improvements: act('Reviewing', '◈', C.understand, 'understand'),
  find_dead_code: act('Scanning', '◈', C.understand, 'understand'),
  analyze_impact: act('Analyzing impact', '◈', C.understand, 'understand'),
  smart_diff: act('Diffing', '◈', C.understand, 'understand'),

  // Frontend
  detect_frontend_stack: act('Detecting stack', '◆', C.vision, 'frontend'),
  analyze_design_system: act('Auditing design', '◆', C.vision, 'frontend'),
  find_ui_components: act('Finding components', '◆', C.vision, 'frontend'),
  design_audit: act('Auditing UI', '◆', C.vision, 'frontend'),

  // Data
  db_schema: act('Reading schema', '◇', C.read, 'data'),
  db_query: act('Querying DB', '⌕', C.search, 'data'),

  // Misc
  mcp_scaffold: act('Scaffolding', '✎', C.write, 'write'),
  generate_release_notes: act('Writing notes', '✎', C.write, 'write'),
};

// Prefix rules — checked in order when no exact match. Covers families like
// code_graph_*, git_*, browser_*, dev_server_*, background_job_*, computer_*.
const PREFIX: Array<[string, ToolActivity]> = [
  ['code_graph', act('Navigating', '⌕', C.search, 'search')],
  ['git_', act('Git', '⎇', C.git, 'git')],
  ['browser_', act('Browsing', '▣', C.browser, 'browser')],
  ['dev_server', act('Dev server', '▣', C.browser, 'browser')],
  ['background_job', act('Background job', '☰', C.plan, 'background')],
  ['computer_', act('Controlling', '▣', C.browser, 'computer')],
];

const DEFAULT: ToolActivity = act('Working', '◆', C.read, 'general');

/** Friendly verb + icon + colour for a tool name. Falls back to a sensible default. */
export function describeToolActivity(name: string): ToolActivity {
  const exact = EXACT[name];
  if (exact) return exact;
  for (const [prefix, a] of PREFIX) {
    if (name.startsWith(prefix)) return a;
  }
  return DEFAULT;
}

const TARGET_KEYS = ['file_path', 'path', 'file', 'query', 'pattern', 'command', 'url', 'symbol', 'name', 'id'];

/**
 * Pull a human-meaningful target out of (possibly incomplete, still-streaming) tool-arg
 * JSON — the path being read, the query being searched, the command being run. Tolerant
 * of an unterminated trailing string (the stream may cut mid-value). Returns null when
 * nothing useful is found.
 */
export function extractTarget(partialArgs: string): string | null {
  if (!partialArgs) return null;
  for (const k of TARGET_KEYS) {
    // Closed string value first.
    const closed = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(partialArgs);
    if (closed && closed[1] != null) return unescapeJson(closed[1]);
  }
  for (const k of TARGET_KEYS) {
    // Unterminated value (stream cut mid-string) — capture to end.
    const open = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)$`).exec(partialArgs);
    if (open && open[1] != null && open[1].length > 0) return unescapeJson(open[1]);
  }
  return null;
}

function unescapeJson(s: string): string {
  return s.replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/** Collapse whitespace and middle-truncate a target string for one-line display. */
export function formatTarget(target: string, max = 44): string {
  const clean = target.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${clean.slice(0, head)}…${clean.slice(clean.length - tail)}`;
}
