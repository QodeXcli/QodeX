/**
 * Stable identity — a short block the model sees on EVERY turn.
 *
 * Project rules (QODEX.md) can be long and change; this file is the opposite:
 * a capped, cache-friendly persona that belongs in the STABLE system prefix.
 *
 * Sources (merged, user first so personal constraints win):
 *   ~/.qodex/IDENTITY.md
 *   <cwd>/.qodex/IDENTITY.md
 *
 * Missing files → empty string (zero token cost). Hard cap so a huge file
 * cannot blow the prefix cache or TTFT.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_HOME } from '../config/defaults.js';

export const IDENTITY_MAX_CHARS = 1_600;

export interface IdentityLoad {
  block: string;
  sources: string[];
}

async function readCapped(file: string): Promise<string | null> {
  try {
    const raw = (await fs.readFile(file, 'utf-8')).trim();
    if (!raw) return null;
    return raw.length > IDENTITY_MAX_CHARS
      ? raw.slice(0, IDENTITY_MAX_CHARS) + '\n…[IDENTITY.md truncated]'
      : raw;
  } catch {
    return null;
  }
}

export function userIdentityPath(): string {
  return path.join(QODEX_HOME, 'IDENTITY.md');
}

export function projectIdentityPath(cwd: string): string {
  return path.join(path.resolve(cwd), '.qodex', 'IDENTITY.md');
}

export async function loadIdentity(cwd: string): Promise<IdentityLoad> {
  const sources: string[] = [];
  const parts: string[] = [];
  const user = await readCapped(userIdentityPath());
  if (user) {
    sources.push(userIdentityPath());
    parts.push(user);
  }
  const project = await readCapped(projectIdentityPath(cwd));
  if (project) {
    sources.push(projectIdentityPath(cwd));
    parts.push(project);
  }
  if (parts.length === 0) return { block: '', sources };
  return { block: parts.join('\n\n'), sources };
}

export function renderIdentitySection(block: string): string {
  if (!block.trim()) return '';
  return `# Standing identity
These constraints and preferences apply to EVERY turn. Honor them over defaults.
${block.trim()}`;
}
