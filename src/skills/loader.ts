import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { logger } from '../utils/logger.js';
import type { SkillSpec, SkillState } from './types.js';
import { claudeCodeSkillDirs } from '../integrations/claude-plugins.js';

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export function userSkillsDir(): string {
  return path.join(os.homedir(), '.qodex', 'skills');
}

export function projectSkillsDir(cwd: string): string {
  return path.join(cwd, '.qodex', 'skills');
}

export function stateFilePath(): string {
  return path.join(userSkillsDir(), '.state.json');
}

export async function loadSkillState(): Promise<SkillState> {
  try {
    const raw = await fs.readFile(stateFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveSkillState(state: SkillState): Promise<void> {
  await fs.mkdir(path.dirname(stateFilePath()), { recursive: true });
  await fs.writeFile(stateFilePath(), JSON.stringify(state, null, 2));
}

/**
 * Scan both discovery directories and return a Map<name, SkillSpec>.
 * Project skills win on name collisions. Disabled skills are filtered out.
 */
export async function loadSkills(cwd: string): Promise<Map<string, SkillSpec>> {
  const state = await loadSkillState();
  const out = new Map<string, SkillSpec>();

  // Claude Code skills come first (lowest precedence) so a user's own QodeX skill
  // of the same name always wins. Order = last-wins in the map below.
  const claudeDirs = (await claudeCodeSkillDirs(cwd)).map(d => ({ root: d.dir, origin: 'plugin' as const }));
  const dirs: Array<{ root: string; origin: SkillSpec['origin'] }> = [
    ...claudeDirs,
    { root: userSkillsDir(), origin: 'user' },
    { root: projectSkillsDir(cwd), origin: 'project' },
  ];

  for (const { root, origin } of dirs) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.')) continue;
      if (!NAME_RE.test(ent.name)) {
        logger.debug('Skipping skill with invalid name', { dir: ent.name });
        continue;
      }
      const skillDir = path.join(root, ent.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      try {
        const raw = await fs.readFile(skillFile, 'utf-8');
        const spec = parseSkill(raw, ent.name, skillDir, origin);
        if (!spec) continue;
        // Apply user-controlled enabled/disabled state (only user-scope; project
        // skills are always enabled when present).
        if (origin === 'user' && state[ent.name]?.enabled === false) continue;
        out.set(ent.name, spec);
      } catch (e: any) {
        logger.warn('Failed to load skill', { dir: skillDir, err: e?.message });
      }
    }
  }

  return out;
}

/** Load a single skill by name without applying enabled-state filtering. */
export async function loadSkillByName(name: string, cwd: string): Promise<SkillSpec | null> {
  for (const { root, origin } of [
    { root: projectSkillsDir(cwd), origin: 'project' as const },
    { root: userSkillsDir(), origin: 'user' as const },
  ]) {
    const skillDir = path.join(root, name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    try {
      const raw = await fs.readFile(skillFile, 'utf-8');
      return parseSkill(raw, name, skillDir, origin);
    } catch {
      continue;
    }
  }
  return null;
}

/** Parse a SKILL.md into a SkillSpec. Returns null if the spec is unusable. */
export function parseSkill(
  raw: string,
  name: string,
  dir: string,
  origin: SkillSpec['origin'],
): SkillSpec | null {
  let body = raw;
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\r?\n?([\s\S]*)$/);
  const fm = fmMatch ? fmMatch[1] ?? '' : '';
  if (fmMatch) body = fmMatch[2] ?? '';

  const fields = parseFrontmatter(fm);

  const description = (fields.description as string | undefined) ?? '';
  if (!description) {
    logger.warn('Skill missing description, skipping', { name, dir });
    return null;
  }

  // name in frontmatter is advisory — directory name wins so installer collisions stay safe.
  return {
    name,
    dir,
    origin,
    description,
    version: fields.version as string | undefined,
    body: body.trim(),
    allowedTools: asStringArray(fields['allowed-tools'] ?? fields['allowed_tools']),
    triggers: asStringArray(fields.triggers),
    slashAliases: asStringArray(fields['slash-aliases'] ?? fields['slash_aliases']),
    model: fields.model as string | undefined,
    files: asStringArray(fields.files),
    author: fields.author as string | undefined,
    source: fields.source as string | undefined,
  };
}

/** Minimal YAML-ish parser. Same shape as custom-commands.ts for consistency. */
function parseFrontmatter(fm: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = fm.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*(#.*)?$/.test(line)) { i++; continue; }
    const m = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1]!.toLowerCase();
    const rawValue = m[2]!.trim();

    if (rawValue === '') {
      const items: string[] = [];
      i++;
      while (i < lines.length && /^\s+-\s+/.test(lines[i]!)) {
        items.push(stripQuotes(lines[i]!.replace(/^\s+-\s+/, '').trim()));
        i++;
      }
      out[key] = items;
    } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      out[key] = rawValue.slice(1, -1).split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
      i++;
    } else {
      out[key] = stripQuotes(rawValue);
      i++;
    }
  }
  return out;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return v.length ? v.map(String) : undefined;
  if (typeof v === 'string' && v.trim()) return [v];
  return undefined;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
