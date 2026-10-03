/**
 * Zero-cost distillation dataset export — ShareGPT JSONL.
 *
 * Training a model isn't a CLI's job, but PRODUCING the dataset is. Every successful
 * task is a real, project-specific instruction example (user ask → reasoning → tool
 * calls → verified result). This module turns the full conversation into the standard
 * ShareGPT shape and appends it to ~/.qodex/dataset/<project>.jsonl. Months later that
 * file is a clean, ready-to-use corpus for a zero-cost local fine-tune — no code ever
 * leaves the machine.
 *
 * ShareGPT line shape:
 *   { "conversations": [ { "from": "system"|"human"|"gpt"|"tool", "value": "..." }, … ] }
 *
 * Pure conversion (`toShareGpt`) is unit-tested; the append is best-effort I/O that never
 * breaks a task that already succeeded.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import type { Message } from '../session/store.js';

export interface ShareGptTurn { from: 'system' | 'human' | 'gpt' | 'tool'; value: string }
export interface ShareGptRecord { conversations: ShareGptTurn[] }

const ROLE_TO_FROM: Record<Message['role'], ShareGptTurn['from']> = {
  system: 'system',
  user: 'human',
  assistant: 'gpt',
  tool: 'tool',
};

/**
 * Convert a QodeX message history into one ShareGPT record. Tool CALLS (on assistant
 * turns) are appended to the assistant value as a readable, trainable block; tool
 * RESULTS become `tool` turns labelled with the tool name. Empty turns are dropped so
 * the transcript stays clean. PURE.
 */
export function toShareGpt(messages: Message[]): ShareGptRecord {
  const conversations: ShareGptTurn[] = [];
  for (const m of messages) {
    const from = ROLE_TO_FROM[m.role];
    let value = (m.content ?? '').trim();

    if (m.role === 'assistant' && m.tool_calls?.length) {
      const calls = m.tool_calls
        .map(tc => `→ ${tc.function.name}(${(tc.function.arguments ?? '').trim()})`)
        .join('\n');
      value = value ? `${value}\n\n[tool calls]\n${calls}` : `[tool calls]\n${calls}`;
    }
    if (m.role === 'tool' && m.name) {
      value = `[${m.name}]\n${value}`;
    }

    if (!value) continue; // skip empty system/assistant placeholders
    conversations.push({ from, value });
  }
  return { conversations };
}

function datasetPath(projectRoot: string): string {
  const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.qodex', 'dataset', `${hash}.jsonl`);
}

/**
 * Append one ShareGPT record for a successful task. Best-effort: a write failure is
 * logged and swallowed. A record with fewer than 2 turns (no real exchange) is skipped.
 */
export async function appendShareGptRecord(projectRoot: string, messages: Message[]): Promise<void> {
  try {
    const rec = toShareGpt(messages);
    if (rec.conversations.length < 2) return; // nothing trainable
    const full = datasetPath(projectRoot);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.appendFile(full, JSON.stringify(rec) + '\n', 'utf-8');
    logger.info('Dataset record exported (ShareGPT)', { file: full, turns: rec.conversations.length });
  } catch (e: any) {
    logger.debug('Dataset export skipped', { err: e?.message });
  }
}

/** Absolute path to a project's ShareGPT dataset (for fine-tune tooling). */
export function getShareGptDatasetPath(projectRoot: string): string {
  return datasetPath(projectRoot);
}
