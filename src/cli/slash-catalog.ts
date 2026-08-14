/**
 * Single catalog of built-in slash commands — help text, Tab autocomplete,
 * and unknown-command suggestions all read from here so they cannot drift.
 */

export interface SlashCatalogEntry {
  name: string;
  /** Optional argument hint shown in autocomplete, e.g. "<query>". */
  args?: string;
  description: string;
}

export const SLASH_CATALOG: readonly SlashCatalogEntry[] = [
  { name: 'help', description: 'Show slash commands' },
  { name: 'clear', description: 'Reset this conversation' },
  { name: 'undo', args: '[N]', description: 'Roll back the last N file transactions' },
  { name: 'retry', description: 'Redo the last turn (drop the last answer, ask again)' },
  { name: 'compact', description: 'Summarize older history to free context' },
  { name: 'search', args: '<query>', description: 'Search past conversations' },
  { name: 'sessions', description: 'List recent sessions' },
  { name: 'resume', args: '<id>', description: 'Continue a previous session' },
  { name: 'plan', description: 'Read-only plan mode' },
  { name: 'normal', description: 'Back to normal (mutating) mode' },
  { name: 'model', args: '[id]', description: 'Show or switch the model' },
  { name: 'auto', args: '[manual|auto|always]', description: 'Approval mode (or Shift+Tab)' },
  { name: 'btw', args: '<note>', description: 'Steer a running task without stopping it' },
  { name: 'effort', args: '<low|medium|high|off>', description: 'Reasoning effort' },
  { name: 'memory', description: 'Show / manage learned facts' },
  { name: 'cost', description: 'Token and cost usage' },
  { name: 'tokens', description: 'Per-turn token breakdown' },
  { name: 'tools', args: '[--all]', description: 'List registered tools' },
  { name: 'skills', description: 'List installed skills' },
  { name: 'skill', args: '<name>', description: 'Run or enable/disable a skill' },
  { name: 'mcp', description: 'MCP server status' },
  { name: 'index', args: '[--force]', description: 'Build / refresh the code graph' },
  { name: 'strict', args: 'on|off', description: 'Production-safety mode' },
  { name: 'snapshot', description: 'Manage auto-snapshots' },
  { name: 'restore', description: 'Restore the latest auto-snapshot' },
  { name: 'unlimited', description: 'Remove the iteration cap this session' },
  { name: 'iterations', args: '<n>', description: 'Set iteration cap (0 = none)' },
  { name: 'network', description: 'Diagnose connectivity' },
  { name: 'commands', description: 'List custom slash commands' },
  { name: 'exit', description: 'Quit QodeX' },
];

export interface SlashSuggestion {
  name: string;
  args?: string;
  description: string;
  /** What to put in the input box if the user accepts this suggestion. */
  insert: string;
}

/** True when the caret is still on the command token (`/hel`, not `/help foo`). */
export function isCompletingSlashName(value: string): boolean {
  if (!value.startsWith('/')) return false;
  return !value.slice(1).includes(' ') && !value.includes('\n');
}

export function suggestSlashCommands(value: string, extraNames: string[] = []): SlashSuggestion[] {
  if (!isCompletingSlashName(value)) return [];
  const prefix = value.slice(1).toLowerCase();
  const extras: SlashCatalogEntry[] = extraNames
    .filter(n => n && !SLASH_CATALOG.some(c => c.name === n))
    .map(name => ({ name, description: 'custom / skill' }));
  const pool = [...SLASH_CATALOG, ...extras];
  return pool
    .filter(c => c.name.startsWith(prefix) || (prefix.length === 0 && true))
    .slice(0, 8)
    .map(c => ({
      name: c.name,
      args: c.args,
      description: c.description,
      insert: `/${c.name}${c.args ? ' ' : ''}`,
    }));
}

/**
 * Tab completion: if exactly one match, insert it; if many, extend to the
 * longest shared prefix. Returns null when there's nothing to apply.
 */
export function completeSlash(value: string, extraNames: string[] = []): string | null {
  const suggestions = suggestSlashCommands(value, extraNames);
  if (suggestions.length === 0) return null;
  if (suggestions.length === 1) {
    const next = suggestions[0]!.insert;
    return next === value ? null : next;
  }
  const names = suggestions.map(s => s.name);
  let shared = names[0]!;
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < shared.length && i < n.length && shared[i] === n[i]) i++;
    shared = shared.slice(0, i);
  }
  const next = `/${shared}`;
  return next.length > value.length ? next : null;
}
