import type { ToolSchema } from '../llm/types.js';

/**
 * Relevance-based tool gating ("send only the tools this task needs").
 *
 * Problem: in normal mode QodeX ships ALL ~65 tool schemas on EVERY request, so
 * even "who are you?" carries the full git/docker/browser/db/media arsenal — a
 * large fixed token tax on every turn. Claude Code stays lean by sending a focused
 * set. This brings the same idea.
 *
 * Three tiers:
 *   1. CORE       — always sent. The universal read/edit/shell/plan loop plus the
 *                   capability-expansion hooks (use_skill/search_skills).
 *   2. COMMON     — sent for any real task (anything that isn't a trivial greeting),
 *                   regardless of natural language. These are broadly useful on
 *                   almost every coding job: git, code-intelligence, frontend, web.
 *                   Tiering these by tier (not keyword) is what makes the gate work
 *                   for a Persian/mixed-language user whose verbs won't match English
 *                   keywords — a real task still gets the common coding tools.
 *   3. SPECIALIST — the rare/heavy families (docker, db, browser, computer-use,
 *                   dev-server, media, wordpress, …). Gated strictly: included only
 *                   when their keywords OR language-agnostic signals (file
 *                   extensions, framework names) appear.
 *
 * CAPABILITY GUARANTEE (verified against registry.execute): gating changes only
 * what the model SEES, never what it can RUN. registry.execute() resolves tools
 * from the full registry regardless of what was shipped, so a model that names an
 * un-shipped tool still executes it. A false negative costs awareness, not ability.
 *
 * Caching: tiers preserve input order, so the cacheable CORE prefix stays stable;
 * only the tail varies.
 */

/** Always shipped. */
export const CORE_TOOLS = new Set<string>([
  'read_file', 'write_file', 'edit_text', 'multi_edit', 'edit_symbol', 'multi_file_edit',
  'ls', 'glob', 'grep',
  'shell',
  'todo_write', 'todo_read', 'remember', 'recall',
  'task', 'orchestrate', 'gather',
  'use_skill', 'search_skills',
  'diagnostics',
]);

/** Sent for ANY non-trivial task (language-agnostic — keyed off task-vs-greeting,
 *  not off keywords). Members are exact names and/or `prefix_` patterns. */
const COMMON_FAMILY_MEMBERS: string[] = [
  // git / change review
  'git_', 'generate_release_notes', 'review_my_changes', 'smart_diff',
  // code intelligence
  'explain_codebase', 'find_dead_code', 'data_flow', 'backend_routemap',
  'openapi_digest', 'semantic_search', 'suggest_improvements', 'auto_fix', 'analyze_impact',
  // frontend / design (Hamed's bread and butter)
  'analyze_design_system', 'design_audit', 'detect_frontend_stack', 'find_ui_components',
  'print_layout_engine', 'seo_audit', 'vision_analyze',
  // web / docs
  'web_search', 'web_fetch', 'brave', 'duckduckgo', 'tavily', 'http_request',
];

interface SpecialistFamily {
  members: string[];
  keywords: string[];
}

/** Rare/heavy families — gated strictly. keywords are matched case-insensitively
 *  against the signal; many are English loanwords Hamed writes in Latin script even
 *  in Persian sentences (docker, sql, react, wordpress, …), plus file extensions. */
const SPECIALIST_FAMILIES: SpecialistFamily[] = [
  { members: ['docker_'], keywords: ['docker', 'container', 'compose', 'dockerfile'] },
  { members: ['db_query', 'db_schema'], keywords: ['database', 'sql', 'postgres', 'mysql', 'sqlite', 'mongo', ' db ', '.sql', 'query'] },
  { members: ['browser_'], keywords: ['browser', 'screenshot', 'headless', 'puppeteer', 'playwright', 'scrape', 'navigate', 'selector'] },
  { members: ['computer_use_'], keywords: ['desktop', 'screen', 'window', 'gui', 'mouse', 'keyboard'] },
  { members: ['dev_server_'], keywords: ['dev server', 'npm run', 'serve', 'localhost', 'vite', 'next dev', 'hot reload', 'hmr'] },
  { members: ['background_job_'], keywords: ['background job', 'long-running', 'long running', 'async job', 'queue', 'worker'] },
  { members: ['csv_read', 'csv_write', 'xlsx_read', 'pdf_read', 'media_probe', 'media_transform'],
    keywords: ['csv', 'excel', 'xlsx', 'spreadsheet', 'pdf', 'video', 'audio', 'ffmpeg', '.csv', '.pdf', '.xlsx', '.mp4', '.png', '.jpg'] },
  { members: ['wp_find_hook', 'wp_list_hooks'], keywords: ['wordpress', 'woocommerce', 'wp_', 'wp-', 'shortcode', 'gutenberg'] },
  // install_skill must surface whenever skills are discussed — otherwise the model can't
  // self-provision a skill it lacks (it never sees the tool) and wrongly says "I can't install".
  { members: ['install_skill'], keywords: ['skill', 'skills', 'اسکیل', 'مهارت', 'plugin'] },
  { members: ['install_mcp', 'mcp_scaffold'], keywords: ['mcp', 'scaffold', 'connector', 'install skill'] },
  { members: ['forget', 'project_log', 'project_recall'], keywords: ['forget', 'project log', 'remember that', 'note that'] },
  { members: ['network_check', 'network_optimize'], keywords: ['network', 'latency', 'dns', 'proxy', 'ping'] },
  { members: ['ci_status'], keywords: [' ci ', 'pipeline', 'github actions', 'workflow run'] },
  { members: ['code_run'], keywords: ['run code', 'eval', 'repl', 'snippet'] },
  // Standalone UI/visual artifacts (html/react/svg/markdown) with versioned manifests.
  // Without this the artifact_* tools matched no tier and were silently never shipped,
  // so the agent never knew it could make an artifact even when asked outright.
  { members: ['artifact_'], keywords: ['artifact', 'artefact', 'آرتیفکت', 'آرتفکت', 'live', 'hot reload', 'hot-reload', 'reload'] },
];

function expand(members: string[], allNames: string[]): Set<string> {
  const out = new Set<string>();
  for (const m of members) {
    if (m.endsWith('_')) { for (const n of allNames) if (n.startsWith(m)) out.add(n); }
    else if (allNames.includes(m)) out.add(m);
  }
  return out;
}

/** A turn is "trivial" (CORE only) when it's short AND carries no task signal.
 *  Case-sensitive code checks (camelCase needs real caps) + substring keyword match
 *  (no \b — \b doesn't work for Persian) so Persian task verbs are detected. */
function isTrivial(signalText: string): boolean {
  const t = signalText.trim();
  if (t.split(/\s+/).filter(Boolean).length > 5) return false; // long → real task
  if (/[a-z][A-Z]/.test(t)) return false;                      // camelCase identifier
  if (/[/._-][a-zA-Z]{1,6}/.test(t)) return false;             // path / .ext / snake_case
  const lower = t.toLowerCase();
  const TASK_WORDS = [
    'fix', 'bug', 'error', 'refactor', 'implement', 'build', 'deploy', 'test', 'debug',
    'create', 'update', 'remove', 'add ', 'edit', 'write', 'change', 'review', 'find',
    'باگ', 'خطا', 'اصلاح', 'بساز', 'پیدا', 'پیاده', 'اضاف', 'تست', 'دیباگ', 'ریفکتور',
    'درست', 'حذف', 'تغییر', 'بنویس', 'بررسی', 'پیدا کن', 'عوض',
  ];
  return !TASK_WORDS.some(w => lower.includes(w));
}

export interface RelevanceResult {
  selected: Set<string>;
  matchedFamilies: number;
  includedAll: boolean;
  trivial: boolean;
}

export function selectRelevantToolNames(allNames: string[], signalText: string): RelevanceResult {
  const text = ` ${signalText.toLowerCase()} `;
  const selected = new Set<string>();

  // Tier 1: CORE always.
  for (const n of allNames) if (CORE_TOOLS.has(n)) selected.add(n);

  const trivial = isTrivial(signalText);

  // Tier 2: COMMON for any real (non-trivial) task — language-agnostic.
  if (!trivial) {
    for (const n of expand(COMMON_FAMILY_MEMBERS, allNames)) selected.add(n);
  }

  // Tier 3: SPECIALIST only on explicit signal.
  let matchedFamilies = 0;
  for (const fam of SPECIALIST_FAMILIES) {
    if (fam.keywords.some(k => text.includes(k))) {
      matchedFamilies++;
      for (const n of expand(fam.members, allNames)) selected.add(n);
    }
  }

  return { selected, matchedFamilies, includedAll: selected.size >= allNames.length, trivial };
}

export function filterSchemasByRelevance(
  schemas: ToolSchema[],
  signalText: string,
): { schemas: ToolSchema[]; matchedFamilies: number; includedAll: boolean; trivial: boolean; before: number; after: number } {
  const allNames = schemas.map(s => s.function.name);
  const { selected, matchedFamilies, includedAll, trivial } = selectRelevantToolNames(allNames, signalText);
  const filtered = schemas.filter(s => selected.has(s.function.name));
  const result = filtered.length > 0 ? filtered : schemas; // never empty
  return {
    schemas: result, matchedFamilies, trivial,
    includedAll: includedAll || result.length === schemas.length,
    before: schemas.length, after: result.length,
  };
}
