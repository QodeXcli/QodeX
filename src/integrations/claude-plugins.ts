/**
 * Claude Code interoperability.
 *
 * Claude Code stores its assets under `~/.claude` and `<project>/.claude`, and installs
 * plugins (from marketplaces) under `~/.claude/plugins`. QodeX natively uses `~/.qodex`
 * and `<project>/.qodex`. This bridge lets QodeX discover and reuse Claude Code's:
 *   - skills        (`<root>/skills/<name>/SKILL.md`)
 *   - slash commands(`<root>/commands/*.md`)
 *
 * Sources, per cwd:
 *   - standalone:  ~/.claude/{skills,commands}  and  <cwd>/.claude/{skills,commands}
 *   - plugins:     each installed plugin's {skills,commands}/ — user-scope plugins always,
 *                  project/local-scope plugins only when their projectPath matches cwd.
 *
 * The SKILL.md / command-markdown formats are the same shape QodeX already parses, so the
 * existing loaders just gain extra roots. Disable with QODEX_DISABLE_CLAUDE_PLUGINS=1.
 *
 * (Plugin `agents/*.md` — Claude Code sub-agent definitions — are NOT mapped yet; that
 * needs role/system-prompt plumbing into the sub-agent runner. Tracked as a follow-up.)
 */

import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import { logger } from '../utils/logger.js';
import type { QodexConfig, RoleConfig } from '../config/defaults.js';
import type { MCPServerConfig } from '../mcp/types.js';
import type { HooksConfig, HookConfig, HookEvent } from '../hooks/types.js';

export type ClaudeAssetOrigin = 'user' | 'project' | 'plugin';
export interface ClaudeAssetDir {
  dir: string;
  origin: ClaudeAssetOrigin;
  /** Plugin name when origin === 'plugin'. */
  plugin?: string;
}

function disabled(): boolean {
  return process.env.QODEX_DISABLE_CLAUDE_PLUGINS === '1';
}

function claudeHome(): string {
  return path.join(os.homedir(), '.claude');
}

interface InstalledPluginsFile {
  version?: number;
  plugins?: Record<string, Array<{ scope?: string; installPath?: string; projectPath?: string }>>;
}

function pathMatches(cwd: string, projectPath: string): boolean {
  const a = path.resolve(cwd);
  const b = path.resolve(projectPath);
  return a === b || a.startsWith(b + path.sep);
}

/**
 * Installed Claude Code plugins relevant to `cwd`: user-scope plugins always apply;
 * project/local-scope plugins only when their recorded projectPath contains cwd.
 */
export async function relevantPluginPaths(cwd: string): Promise<Array<{ name: string; path: string }>> {
  const file = path.join(claudeHome(), 'plugins', 'installed_plugins.json');
  let json: InstalledPluginsFile;
  try {
    json = JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return [];
  }
  const out: Array<{ name: string; path: string }> = [];
  for (const [key, entries] of Object.entries(json.plugins ?? {})) {
    const name = key.split('@')[0] ?? key;
    for (const e of entries ?? []) {
      if (!e.installPath) continue;
      const scope = e.scope ?? 'user';
      if (scope === 'user' || (e.projectPath && pathMatches(cwd, e.projectPath))) {
        out.push({ name, path: e.installPath });
      }
    }
  }
  return out;
}

/** Extra skill roots contributed by Claude Code, lowest-precedence first. */
export async function claudeCodeSkillDirs(cwd: string): Promise<ClaudeAssetDir[]> {
  if (disabled()) return [];
  const dirs: ClaudeAssetDir[] = [];
  try {
    for (const p of await relevantPluginPaths(cwd)) {
      dirs.push({ dir: path.join(p.path, 'skills'), origin: 'plugin', plugin: p.name });
    }
  } catch (e: any) {
    logger.debug('claudeCodeSkillDirs: plugin scan failed', { err: e?.message });
  }
  dirs.push({ dir: path.join(claudeHome(), 'skills'), origin: 'user' });
  dirs.push({ dir: path.join(cwd, '.claude', 'skills'), origin: 'project' });
  return dirs;
}

/** Extra command roots contributed by Claude Code, lowest-precedence first. */
export async function claudeCodeCommandDirs(cwd: string): Promise<ClaudeAssetDir[]> {
  if (disabled()) return [];
  const dirs: ClaudeAssetDir[] = [];
  try {
    for (const p of await relevantPluginPaths(cwd)) {
      dirs.push({ dir: path.join(p.path, 'commands'), origin: 'plugin', plugin: p.name });
    }
  } catch (e: any) {
    logger.debug('claudeCodeCommandDirs: plugin scan failed', { err: e?.message });
  }
  dirs.push({ dir: path.join(claudeHome(), 'commands'), origin: 'user' });
  dirs.push({ dir: path.join(cwd, '.claude', 'commands'), origin: 'project' });
  return dirs;
}

// ───────────────────────────── Agents → roles ──────────────────────────────
//
// Claude Code "agents" are sub-agent definitions: a markdown file with frontmatter
// (name, description, model, tools) and a body that IS the agent's system prompt.
// QodeX's `task` tool dispatches sub-agents by ROLE, reading config.roles.<role>
// for { model, systemPrompt, allowedTools }. So we import each agent as a role —
// then `task({ role: "code-reviewer" })` just works, and the plugin's own
// `/review-pr` command (which dispatches these agents) runs end-to-end.

// Claude Code tool names → QodeX tool names. Unmapped names are dropped (the
// sub-agent runner filters allowedTools against the registry anyway).
const TOOL_NAME_MAP: Record<string, string[]> = {
  read: ['read_file'],
  write: ['write_file'],
  edit: ['edit_text', 'multi_edit'],
  multiedit: ['multi_edit'],
  bash: ['shell', 'code_run'],
  grep: ['grep'],
  glob: ['glob'],
  ls: ['ls'],
  task: ['task'],
  webfetch: ['web_fetch'],
  websearch: ['web_search'],
};

function mapTools(tools: unknown): string[] | undefined {
  if (!tools) return undefined;
  const list = Array.isArray(tools) ? tools : String(tools).split(',');
  const out = new Set<string>();
  for (const t of list) {
    const key = String(t).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const mapped of TOOL_NAME_MAP[key] ?? []) out.add(mapped);
  }
  return out.size > 0 ? [...out] : undefined;
}

function parseAgent(raw: string, fallbackName: string): { name: string; role: RoleConfig } | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\r?\n?([\s\S]*)$/);
  let fm: any = {};
  let body = raw;
  if (m) {
    try { fm = (yaml.load(m[1] ?? '') as any) ?? {}; } catch { fm = {}; }
    body = m[2] ?? '';
  }
  const name = String(fm.name ?? fallbackName).trim();
  if (!/^[a-zA-Z][\w-]*$/.test(name)) return null;
  if (!body.trim()) return null;
  const role: RoleConfig = {
    systemPrompt: body.trim(),
    allowedTools: mapTools(fm.tools),
    description: typeof fm.description === 'string' ? fm.description.split('\n')[0]!.slice(0, 200) : undefined,
    origin: 'plugin',
    // model intentionally omitted: agent files often request cloud aliases (opus/
    // sonnet/inherit). Local-first QodeX inherits roles.subagent → parent instead,
    // so imported agents run on the user's own model without needing cloud keys.
  };
  return { name, role };
}

/** Load Claude Code agents (plugins + standalone .claude/agents) as QodeX roles. */
export async function loadClaudeCodeAgents(cwd: string): Promise<Record<string, RoleConfig>> {
  if (disabled()) return {};
  const dirs: string[] = [];
  try {
    for (const p of await relevantPluginPaths(cwd)) dirs.push(path.join(p.path, 'agents'));
  } catch { /* ignore */ }
  dirs.push(path.join(claudeHome(), 'agents'));        // user standalone
  dirs.push(path.join(cwd, '.claude', 'agents'));      // project standalone (wins — listed last)

  const out: Record<string, RoleConfig> = {};
  for (const dir of dirs) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      try {
        const parsed = parseAgent(await fs.readFile(path.join(dir, ent.name), 'utf-8'), ent.name.slice(0, -3));
        if (parsed) out[parsed.name] = parsed.role; // later dirs override earlier
      } catch (e: any) {
        logger.debug('Failed to parse Claude Code agent', { file: ent.name, err: e?.message });
      }
    }
  }
  return out;
}

/**
 * Merge imported Claude Code agents into config.roles (mutates config). User-defined
 * config roles always win over imported agents. Returns how many agents were added.
 */
export async function mergeClaudeCodeAgentRoles(config: QodexConfig, cwd: string): Promise<number> {
  if (disabled()) return 0;
  let agents: Record<string, RoleConfig>;
  try {
    agents = await loadClaudeCodeAgents(cwd);
  } catch (e: any) {
    logger.debug('mergeClaudeCodeAgentRoles failed', { err: e?.message });
    return 0;
  }
  const names = Object.keys(agents);
  if (names.length === 0) return 0;
  const existing = ((config as any).roles ?? {}) as Record<string, RoleConfig | undefined>;
  // Imported agents first, user config last → user wins on name collisions.
  (config as any).roles = { ...agents, ...existing };
  const added = names.filter(n => !existing[n]).length;
  logger.info('Imported Claude Code agents as roles', { found: names.length, added });
  return added;
}

// ──────────────────────── MCP servers + hooks ──────────────────────────────

const PLUGIN_ROOT_RE = /\$\{?(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}?/g;

function substitutePluginRoot<T>(value: T, root: string): T {
  if (typeof value === 'string') return value.replace(PLUGIN_ROOT_RE, root) as unknown as T;
  if (Array.isArray(value)) return value.map(v => substitutePluginRoot(v, root)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitutePluginRoot(v as any, root);
    return out;
  }
  return value;
}

async function readJsonIfExists(file: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf-8')); } catch { return null; }
}

/** Discover MCP servers declared by Claude Code plugins (plugin.json mcpServers + .mcp.json). */
export async function loadClaudeCodePluginMcpServers(cwd: string): Promise<Record<string, MCPServerConfig>> {
  if (disabled()) return {};
  const out: Record<string, MCPServerConfig> = {};
  let plugins: Array<{ name: string; path: string }> = [];
  try { plugins = await relevantPluginPaths(cwd); } catch { return {}; }
  for (const p of plugins) {
    const manifest = await readJsonIfExists(path.join(p.path, '.claude-plugin', 'plugin.json'));
    const dotMcp = await readJsonIfExists(path.join(p.path, '.mcp.json'));
    const servers = { ...(manifest?.mcpServers ?? {}), ...(dotMcp?.mcpServers ?? {}) };
    for (const [name, raw] of Object.entries(servers)) {
      if (!raw || typeof raw !== 'object') continue;
      // Namespace by plugin to avoid collisions, mirroring Claude Code conventions.
      out[`${p.name}:${name}`] = substitutePluginRoot(raw as MCPServerConfig, p.path);
    }
  }
  return out;
}

const SUPPORTED_HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'PreCompact'];

/**
 * Discover hooks declared by Claude Code plugins (plugin.json `hooks` or hooks/hooks.json)
 * and flatten Claude Code's nested shape — `{ Event: [{ matcher, hooks: [{type, command}] }] }`
 * — into QodeX's flat `{ Event: [{ matcher, command }] }`.
 */
export async function loadClaudeCodePluginHooks(cwd: string): Promise<HooksConfig> {
  if (disabled()) return {};
  const out: HooksConfig = {};
  let plugins: Array<{ name: string; path: string }> = [];
  try { plugins = await relevantPluginPaths(cwd); } catch { return {}; }
  for (const p of plugins) {
    const manifest = await readJsonIfExists(path.join(p.path, '.claude-plugin', 'plugin.json'));
    const hooksFile = await readJsonIfExists(path.join(p.path, 'hooks', 'hooks.json'));
    const raw = manifest?.hooks && typeof manifest.hooks === 'object' ? manifest.hooks
      : hooksFile?.hooks && typeof hooksFile.hooks === 'object' ? hooksFile.hooks
      : hooksFile ?? null;
    if (!raw || typeof raw !== 'object') continue;
    for (const event of SUPPORTED_HOOK_EVENTS) {
      const groups = (raw as any)[event];
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const matcher: string | undefined = typeof group?.matcher === 'string' ? group.matcher : undefined;
        const hooksArr = Array.isArray(group?.hooks) ? group.hooks : [group];
        for (const h of hooksArr) {
          if (!h || (h.type && h.type !== 'command') || typeof h.command !== 'string') continue;
          const hook: HookConfig = {
            command: substitutePluginRoot(h.command, p.path),
            ...(matcher ? { matcher } : {}),
            ...(typeof h.timeout === 'number' ? { timeout: h.timeout } : {}),
            name: `${p.name}:${event}`,
            // Imported hooks are informational by default — never silently veto the user's tools.
            blocking: false,
          };
          (out[event] ??= []).push(hook);
        }
      }
    }
  }
  return out;
}

/** Merge plugin MCP servers into config.mcp.servers (mutates). User config wins. Returns count added. */
export async function mergeClaudeCodePluginMcp(config: QodexConfig, cwd: string): Promise<number> {
  if (disabled()) return 0;
  const servers = await loadClaudeCodePluginMcpServers(cwd).catch(() => ({}));
  const names = Object.keys(servers);
  if (names.length === 0) return 0;
  const mcp = ((config as any).mcp ??= { servers: {} });
  mcp.servers ??= {};
  let added = 0;
  for (const [name, cfg] of Object.entries(servers)) {
    if (mcp.servers[name]) continue; // user config wins
    mcp.servers[name] = cfg;
    added++;
  }
  if (added) logger.info('Imported Claude Code plugin MCP servers', { added });
  return added;
}

/** Merge plugin hooks into config.hooks (mutates, appends). Returns count added. */
export async function mergeClaudeCodePluginHooks(config: QodexConfig, cwd: string): Promise<number> {
  if (disabled()) return 0;
  const hooks = await loadClaudeCodePluginHooks(cwd).catch(() => ({} as HooksConfig));
  const cfgHooks = ((config as any).hooks ??= {});
  let added = 0;
  for (const event of SUPPORTED_HOOK_EVENTS) {
    const incoming = hooks[event];
    if (!incoming?.length) continue;
    (cfgHooks[event] ??= []).push(...incoming);
    added += incoming.length;
  }
  if (added) logger.info('Imported Claude Code plugin hooks', { added });
  return added;
}

/** One-shot: import agents + MCP servers + hooks from Claude Code into config (mutates). */
export async function applyClaudeCodeIntegration(
  config: QodexConfig,
  cwd: string,
): Promise<{ agents: number; mcp: number; hooks: number }> {
  const agents = await mergeClaudeCodeAgentRoles(config, cwd);
  const mcp = await mergeClaudeCodePluginMcp(config, cwd);
  const hooks = await mergeClaudeCodePluginHooks(config, cwd);
  return { agents, mcp, hooks };
}
