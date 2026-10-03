/**
 * User plugins — drop a folder in ~/.qodex/plugins or <cwd>/.qodex/plugins,
 * no rebuild. Each plugin is a plugin.json of named shell templates.
 *
 * We never require()/eval user code. That's the performance and safety win
 * over a JS plugin loader: discovery is a handful of stat+JSON parses, and
 * a bad plugin cannot take down the process.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_HOME } from '../config/defaults.js';
import { logger } from '../utils/logger.js';
import type { ToolRegistry } from '../tools/registry.js';
import { UserPluginTool, isSafeToolName, type UserToolSpec } from './user-tool.js';

export interface PluginManifest {
  name: string;
  description?: string;
  tools?: Array<{
    name: string;
    description: string;
    command: string;
    args?: string[];
    destructive?: boolean;
    timeoutSeconds?: number;
  }>;
}

export interface LoadedPlugin {
  name: string;
  dir: string;
  description: string;
  tools: string[];
}

export function userPluginsDir(): string {
  return path.join(QODEX_HOME, 'plugins');
}

export function projectPluginsDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.qodex', 'plugins');
}

async function listPluginDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(root, e.name));
  } catch {
    return [];
  }
}

export async function readManifest(dir: string): Promise<PluginManifest | null> {
  for (const file of ['plugin.json', 'plugin.yaml']) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8');
      if (file.endsWith('.json')) return JSON.parse(raw) as PluginManifest;
      const yaml = await import('js-yaml');
      return yaml.load(raw) as PluginManifest;
    } catch { /* try next */ }
  }
  return null;
}

export async function discoverPlugins(cwd: string): Promise<LoadedPlugin[]> {
  const dirs = [
    ...(await listPluginDirs(userPluginsDir())),
    ...(await listPluginDirs(projectPluginsDir(cwd))),
  ];
  const out: LoadedPlugin[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const man = await readManifest(dir);
    if (!man?.name || !isSafeToolName(man.name.replace(/-/g, '_'))) {
      logger.warn('Skipping plugin with invalid manifest', { dir });
      continue;
    }
    if (seen.has(man.name)) continue; // project wins if listed second? user first then project overwrites — flip: later wins
    seen.add(man.name);
    const tools = (man.tools ?? []).map(t => t.name).filter(isSafeToolName);
    out.push({ name: man.name, dir, description: man.description ?? '', tools });
  }
  return out;
}

let lastLoaded: LoadedPlugin[] = [];
export function lastLoadedPlugins(): LoadedPlugin[] { return lastLoaded; }

export async function registerUserPlugins(registry: ToolRegistry, cwd: string): Promise<LoadedPlugin[]> {
  const dirs = [
    ...(await listPluginDirs(userPluginsDir())),
    ...(await listPluginDirs(projectPluginsDir(cwd))),
  ];
  const loaded: LoadedPlugin[] = [];
  const taken = new Set(registry.list().map(t => t.name));

  for (const dir of dirs) {
    const man = await readManifest(dir);
    if (!man?.name) continue;
    const registered: string[] = [];
    for (const t of man.tools ?? []) {
      if (!isSafeToolName(t.name) || !t.command?.trim() || !t.description?.trim()) {
        logger.warn('Plugin tool skipped (bad name/command/description)', { plugin: man.name, tool: t.name });
        continue;
      }
      if (taken.has(t.name)) {
        logger.warn('Plugin tool skipped — name collides with a builtin', { plugin: man.name, tool: t.name });
        continue;
      }
      const spec: UserToolSpec = {
        name: t.name,
        description: t.description,
        command: t.command,
        args: (t.args ?? []).filter(isSafeToolName),
        destructive: !!t.destructive,
        timeoutSeconds: t.timeoutSeconds,
        plugin: man.name,
      };
      registry.register(new UserPluginTool(spec));
      taken.add(t.name);
      registered.push(t.name);
    }
    if (registered.length) {
      loaded.push({ name: man.name, dir, description: man.description ?? '', tools: registered });
      logger.info('Plugin loaded', { name: man.name, tools: registered.length });
    }
  }
  lastLoaded = loaded;
  return loaded;
}
