/**
 * The last place a person reached the resident. One file. Not a model memory.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { presencePath } from './paths.js';

export interface Presence {
  project: string;
  channel: string;
  at: string;
  summary: string;
}

export function reachSummary(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  return one
    .replace(/Bearer\s+\S+/gi, 'Bearer [omitted]')
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, '[omitted]');
}

export async function writePresence(p: Presence): Promise<void> {
  const file = presencePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(p));
  await fs.rename(tmp, file);
}

export async function readPresence(): Promise<Presence | null> {
  try {
    const raw = JSON.parse(await fs.readFile(presencePath(), 'utf-8')) as Presence;
    if (!raw || typeof raw.channel !== 'string' || typeof raw.at !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

export async function recordReach(input: { project: string; channel: string; text: string; at?: string }): Promise<void> {
  await writePresence({
    project: input.project,
    channel: input.channel,
    at: input.at ?? new Date().toISOString(),
    summary: reachSummary(input.text),
  });
}
