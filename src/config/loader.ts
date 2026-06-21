import { promises as fs } from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { DEFAULT_CONFIG, QODEX_CONFIG_FILE, QODEX_HOME, type QodexConfig } from './defaults.js';
import { logger } from '../utils/logger.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { withLock } from '../utils/file-lock.js';

/**
 * Deep merge two configuration objects.
 * Rules:
 *  - If override is undefined, keep base.
 *  - If types mismatch (array vs object, primitive vs object), override wins outright — no merging.
 *  - Arrays are NEVER merged element-by-element — override array replaces base array.
 *  - Plain objects are merged recursively per-key.
 *  - Primitives: override wins.
 */
function deepMerge<T>(base: T, override: any): T {
  if (override === undefined) return base;
  if (override === null) return null as unknown as T;

  const baseIsArray = Array.isArray(base);
  const overrideIsArray = Array.isArray(override);

  // Arrays never merge — override replaces. Same when types mismatch.
  if (baseIsArray || overrideIsArray) {
    return overrideIsArray ? (override as T) : (override as T);
  }

  const baseIsObj = typeof base === 'object' && base !== null;
  const overrideIsObj = typeof override === 'object' && override !== null;

  // Type mismatch (e.g., user wrote a string where default is an object) → override wins
  if (!baseIsObj || !overrideIsObj) {
    return override as T;
  }

  // Both are plain objects → recurse per key
  const result: any = { ...(base as any) };
  for (const key of Object.keys(override)) {
    const ov = override[key];
    if (ov === undefined) continue;
    result[key] = deepMerge((base as any)[key], ov);
  }
  return result as T;
}

export async function ensureQodexHome(): Promise<void> {
  try {
    await fs.mkdir(QODEX_HOME, { recursive: true });
  } catch (e: any) {
    // Common failure: HOME is unset or wrong → QODEX_HOME resolves to a path
    // we can't write to. Print a diagnostic with the resolved values so the
    // user knows what to fix, then rethrow.
    const os = await import('os');
    process.stderr.write(
      `\n[QodeX] Cannot create config directory: ${QODEX_HOME}\n` +
      `  os.homedir() = ${os.homedir()}\n` +
      `  HOME env     = ${process.env.HOME ?? '(unset)'}\n` +
      `  USER env     = ${process.env.USER ?? '(unset)'}\n` +
      `  Error: ${e?.message ?? e}\n\n` +
      `If you launched QodeX from VS Code or a GUI without proper env,\n` +
      `try: cd ~ && qodex   (or set HOME=/Users/$(whoami) before launching)\n\n`,
    );
    throw e;
  }
}

/**
 * A config file must parse to a plain object to be mergeable. A YAML file that
 * is syntactically valid but collapses to a scalar (`42`, `just a string`) or a
 * top-level array (`- a\n- b`) would otherwise be handed to deepMerge, whose
 * "type mismatch → override wins" rule replaces the ENTIRE config object with
 * that scalar/array — silently corrupting config for every downstream reader.
 * We reject those here instead of clobbering.
 */
function isMergeableConfig(parsed: unknown): parsed is Partial<QodexConfig> {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

export async function loadConfig(cwd: string = process.cwd()): Promise<QodexConfig> {
  await ensureQodexHome();

  let config = { ...DEFAULT_CONFIG };

  // User-level config
  try {
    const userYaml = await fs.readFile(QODEX_CONFIG_FILE, 'utf-8');
    const userCfg = yaml.load(userYaml);
    if (isMergeableConfig(userCfg)) config = deepMerge(config, userCfg);
    else if (userCfg != null) {
      logger.warn('Ignoring user config: top-level value is not a mapping', { file: QODEX_CONFIG_FILE, got: Array.isArray(userCfg) ? 'array' : typeof userCfg });
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      logger.warn('Failed to load user config', { err: err.message });
    }
  }

  // Project-level config
  const projectConfig = path.join(cwd, '.qodex', 'config.yaml');
  try {
    const projectYaml = await fs.readFile(projectConfig, 'utf-8');
    const projCfg = yaml.load(projectYaml);
    if (isMergeableConfig(projCfg)) config = deepMerge(config, projCfg);
    else if (projCfg != null) {
      logger.warn('Ignoring project config: top-level value is not a mapping', { file: projectConfig, got: Array.isArray(projCfg) ? 'array' : typeof projCfg });
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      logger.warn('Failed to load project config', { err: err.message });
    }
  }

  return config;
}

export async function saveUserConfig(config: Partial<QodexConfig>): Promise<void> {
  await ensureQodexHome();
  await withLock(QODEX_CONFIG_FILE + '.lock', async () => {
    const yamlText = yaml.dump(config, { indent: 2, lineWidth: 100 });
    await writeFileAtomic(QODEX_CONFIG_FILE, yamlText);
  });
}

export async function configExists(): Promise<boolean> {
  try {
    await fs.access(QODEX_CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Active-config singleton.
//
// Tools that need to read user config (e.g. `web_search` choosing a backend) can call
// `getActiveConfig()` instead of receiving config through their constructor — this keeps
// the Tool base class's surface minimal. Bootstrap calls `setActiveConfig(cfg)` once
// during startup; thereafter every caller sees the same instance.

let _active: QodexConfig | null = null;
export function setActiveConfig(cfg: QodexConfig): void { _active = cfg; }
export function getActiveConfig(): QodexConfig | null { return _active; }
