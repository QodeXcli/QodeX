#!/usr/bin/env node
/**
 * Export QodeX session history → chat-format JSONL for LoRA/QLoRA fine-tuning.
 *
 * Reads ~/.qodex/sessions.db (the same DB the `remember` tool and sessions use) and
 * emits one training example per session as {"messages":[{role,content},...]}, the
 * format both MLX-LM (`lora`) and Unsloth/TRL accept after applying the chat template.
 *
 * Real agentic traces (user → assistant(tool_calls) → tool → assistant) are preserved
 * so the adapter learns YOUR read→edit→verify loop, not generic chat.
 *
 * Usage:  node export-dataset.mjs
 * Env:    QODEX_DB, MIN_TURNS=2, VALID_FRACTION=0.1, MAX_TOOL_CHARS=4000, INCLUDE_TOOLS=1
 */

import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const DB = process.env.QODEX_DB || path.join(os.homedir(), '.qodex', 'sessions.db');
const MIN_TURNS = Number(process.env.MIN_TURNS ?? 2);
const VALID_FRACTION = Number(process.env.VALID_FRACTION ?? 0.1);
const MAX_TOOL_CHARS = Number(process.env.MAX_TOOL_CHARS ?? 4000);
const INCLUDE_TOOLS = (process.env.INCLUDE_TOOLS ?? '1') !== '0';
// Quality gate: drop a session where ONE tool name is called more than this many times.
// That pattern is the degenerate "drift loop" (e.g. read_file ×20, grep ×20 going nowhere) —
// training on it teaches the model to loop MORE, the opposite of what a tool-calling tune wants.
// Set MAX_SAME_TOOL=0 to disable the filter.
const MAX_SAME_TOOL = Number(process.env.MAX_SAME_TOOL ?? 12);
const OUT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'data');

function clip(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} chars truncated]` : s;
}

/**
 * Highest count of any single tool name across the session's assistant tool calls.
 * A high number means the model hammered one tool — the loop signature we want to exclude.
 */
function maxSameToolCount(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (r.role !== 'assistant' || !r.tool_calls_json) continue;
    try {
      for (const c of JSON.parse(r.tool_calls_json)) {
        const name = c.function?.name ?? c.name ?? 'tool';
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    } catch { /* ignore malformed */ }
  }
  let max = 0;
  for (const v of counts.values()) if (v > max) max = v;
  return max;
}

function buildExample(rows) {
  const messages = [];
  let userCount = 0;
  let assistantWithContent = 0;

  for (const r of rows) {
    const role = r.role;
    let content = r.content ?? '';

    if (role === 'assistant') {
      // Fold tool calls into the assistant turn so the loop structure is learned.
      if (INCLUDE_TOOLS && r.tool_calls_json) {
        try {
          const calls = JSON.parse(r.tool_calls_json);
          const rendered = calls
            .map((c) => `→ ${c.function?.name ?? c.name ?? 'tool'}(${clip(c.function?.arguments ?? '', 400)})`)
            .join('\n');
          content = (content ? content + '\n' : '') + rendered;
        } catch { /* ignore malformed */ }
      }
      if (content.trim()) assistantWithContent++;
      messages.push({ role: 'assistant', content });
    } else if (role === 'tool') {
      if (!INCLUDE_TOOLS) continue;
      messages.push({
        role: 'tool',
        content: clip(content, MAX_TOOL_CHARS),
        ...(r.name ? { name: r.name } : {}),
      });
    } else if (role === 'user') {
      userCount++;
      messages.push({ role: 'user', content });
    } else if (role === 'system') {
      messages.push({ role: 'system', content });
    }
  }

  // Quality gates: needs a real exchange, not an empty/aborted session.
  if (userCount < 1 || assistantWithContent < 1) return { example: null, reason: 'empty' };
  if (messages.filter((m) => m.role === 'user' || m.role === 'assistant').length < MIN_TURNS) {
    return { example: null, reason: 'trivial' };
  }
  // Drop degenerate tool-loop sessions so we don't teach the model to loop.
  if (MAX_SAME_TOOL > 0 && maxSameToolCount(rows) > MAX_SAME_TOOL) {
    return { example: null, reason: 'loop' };
  }
  return { example: { messages }, reason: null };
}

async function main() {
  let db;
  try {
    db = new Database(DB, { readonly: true });
  } catch (e) {
    console.error(`Cannot open ${DB}: ${e.message}`);
    process.exit(1);
  }

  const sessions = db.prepare(`SELECT id FROM sessions ORDER BY created_at ASC`).all();
  const msgStmt = db.prepare(
    `SELECT role, content, tool_calls_json, tool_call_id, name
     FROM messages WHERE session_id = ? ORDER BY turn_number ASC, id ASC`,
  );

  const examples = [];
  const dropped = { empty: 0, trivial: 0, loop: 0 };
  for (const s of sessions) {
    const rows = msgStmt.all(s.id);
    const { example, reason } = buildExample(rows);
    if (example) examples.push(example);
    else if (reason && reason in dropped) dropped[reason]++;
  }

  if (examples.length === 0) {
    console.error('No usable sessions found. Use QodeX a bit, then re-run.');
    process.exit(1);
  }

  // Deterministic shuffle (seeded) so re-runs are stable.
  let seed = 1337;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  examples.sort(() => rnd() - 0.5);

  const nValid = Math.max(1, Math.floor(examples.length * VALID_FRACTION));
  const valid = examples.slice(0, nValid);
  const train = examples.slice(nValid);

  await fs.mkdir(OUT_DIR, { recursive: true });
  const write = async (name, arr) =>
    fs.writeFile(path.join(OUT_DIR, name), arr.map((e) => JSON.stringify(e)).join('\n') + '\n');
  await write('train.jsonl', train);
  await write('valid.jsonl', valid);

  console.log(`Exported ${examples.length} sessions → ${OUT_DIR}`);
  console.log(`  train.jsonl: ${train.length}`);
  console.log(`  valid.jsonl: ${valid.length}`);
  console.log(`  tools included: ${INCLUDE_TOOLS}`);
  console.log(`  dropped — loop/degenerate: ${dropped.loop}, trivial: ${dropped.trivial}, empty: ${dropped.empty}`);
  if (dropped.loop > 0) {
    console.log(`  (loop filter: sessions where one tool was called >${MAX_SAME_TOOL}× — set MAX_SAME_TOOL=0 to keep them)`);
  }
  if (examples.length < 50) {
    console.log('\nNote: small dataset. Fine-tuning shines with a few hundred+ sessions —');
    console.log('keep using QodeX and re-run to grow the set.');
  }
}

main();
