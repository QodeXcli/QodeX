/**
 * Named config profiles.
 *
 * `-p` is already `--print`. A profile is `--profile <name>` / `QODEX_PROFILE`
 * / `defaults.profile` — a last-word overlay on the merged user+project config.
 *
 * Sources, first match wins:
 *   1. ~/.qodex/profiles/<name>.yaml
 *   2. profiles.<name> block inside ~/.qodex/config.yaml
 *
 * PURE name/resolve helpers live here so tests never touch the real home dir.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { QODEX_CONFIG_FILE, QODEX_PROFILES_DIR, type QodexConfig } from './defaults.js';

export const PROFILE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;

export class UnknownProfileError extends Error {
  readonly code = 'UNKNOWN_PROFILE';
  constructor(public readonly profile: string, public readonly lookedIn: string[]) {
    super(
      `Unknown profile "${profile}". Create ${lookedIn[0] ?? 'a profiles/<name>.yaml'} ` +
      `or add profiles.${profile} to ~/.qodex/config.yaml.`,
    );
    this.name = 'UnknownProfileError';
  }
}

export class InvalidProfileNameError extends Error {
  readonly code = 'INVALID_PROFILE';
  constructor(public readonly profile: string) {
    super(
      `Invalid profile name "${profile}". Use a letter followed by letters, digits, _ or - (max 63).`,
    );
    this.name = 'InvalidProfileNameError';
  }
}

export function assertProfileName(name: string): string {
  const n = name.trim();
  if (!PROFILE_NAME_RE.test(n)) throw new InvalidProfileNameError(name);
  return n;
}

/** flag → env → sticky CLI choice → defaults.profile in already-merged config. */
export function resolveProfileName(opts: {
  flag?: string | null;
  env?: string | null;
  sticky?: string | null;
  configured?: string | null;
}): string | undefined {
  for (const raw of [opts.flag, opts.env, opts.sticky, opts.configured]) {
    const n = (raw ?? '').trim();
    if (n) return n;
  }
  return undefined;
}

export function profileFilePath(name: string, profileDir: string = QODEX_PROFILES_DIR): string {
  return path.join(profileDir, `${assertProfileName(name)}.yaml`);
}

export interface ProfileHit {
  name: string;
  source: 'file' | 'inline';
  path: string;
  overlay: Partial<QodexConfig>;
}

function asMapping(parsed: unknown): Record<string, unknown> | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function stripNestedProfiles(overlay: Record<string, unknown>): Partial<QodexConfig> {
  const { profiles: _ignored, ...rest } = overlay;
  return rest as Partial<QodexConfig>;
}

export async function loadProfileOverlay(
  name: string,
  opts: {
    profileDir?: string;
    userConfigPath?: string;
    inline?: Record<string, unknown> | null;
  } = {},
): Promise<ProfileHit> {
  const id = assertProfileName(name);
  const profileDir = opts.profileDir ?? QODEX_PROFILES_DIR;
  const file = profileFilePath(id, profileDir);
  const userConfigPath = opts.userConfigPath ?? QODEX_CONFIG_FILE;

  try {
    const raw = await fs.readFile(file, 'utf-8');
    const mapped = asMapping(yaml.load(raw));
    if (!mapped) {
      throw new Error(`Profile "${id}" at ${file} is not a YAML mapping.`);
    }
    return { name: id, source: 'file', path: file, overlay: stripNestedProfiles(mapped) };
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  let inline = opts.inline;
  if (inline === undefined) {
    inline = null;
    try {
      const raw = await fs.readFile(userConfigPath, 'utf-8');
      const mapped = asMapping(yaml.load(raw));
      const block = mapped?.profiles;
      if (asMapping(block)) inline = block as Record<string, unknown>;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        throw new Error(`Cannot read ${userConfigPath} for profiles.${id}: ${err?.message ?? err}`);
      }
    }
  }

  const fromInline = inline ? asMapping(inline[id]) : null;
  if (fromInline) {
    return {
      name: id,
      source: 'inline',
      path: userConfigPath,
      overlay: stripNestedProfiles(fromInline),
    };
  }

  throw new UnknownProfileError(id, [file, `${userConfigPath} → profiles.${id}`]);
}

export async function listProfiles(opts: {
  profileDir?: string;
  userConfigPath?: string;
} = {}): Promise<Array<{ name: string; source: 'file' | 'inline'; path: string }>> {
  const profileDir = opts.profileDir ?? QODEX_PROFILES_DIR;
  const userConfigPath = opts.userConfigPath ?? QODEX_CONFIG_FILE;
  const out = new Map<string, { name: string; source: 'file' | 'inline'; path: string }>();

  try {
    const names = await fs.readdir(profileDir);
    for (const f of names) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      const name = f.replace(/\.ya?ml$/u, '');
      if (!PROFILE_NAME_RE.test(name)) continue;
      out.set(name, { name, source: 'file', path: path.join(profileDir, f) });
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  try {
    const raw = await fs.readFile(userConfigPath, 'utf-8');
    const mapped = asMapping(yaml.load(raw));
    const block = mapped?.profiles;
    if (asMapping(block)) {
      for (const name of Object.keys(block as object)) {
        if (!PROFILE_NAME_RE.test(name) || out.has(name)) continue;
        out.set(name, { name, source: 'inline', path: userConfigPath });
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

let _cliProfile: string | undefined;
let _active: ProfileHit | null = null;

export function setRequestedProfile(name: string | undefined): void {
  _cliProfile = name?.trim() || undefined;
}

export function getRequestedProfile(): string | undefined {
  return _cliProfile;
}

export function setActiveProfile(hit: ProfileHit | null): void {
  _active = hit;
}

export function getActiveProfile(): ProfileHit | null {
  return _active;
}

/** Tests only. */
export function resetProfileState(): void {
  _cliProfile = undefined;
  _active = null;
}
