/**
 * Failure-driven learning — lightweight episodic memory of tool failures, mined for
 * RECURRING patterns and turned into "learned cautions" injected into future prompts so
 * the agent stops repeating the same mistake (e.g. "verify a symbol exists before
 * edit_symbol").
 *
 * Safety, by construction (same discipline as the rest of the loop):
 *   - We learn ONLY from REPETITION — a pattern must recur ≥ minOccurrences across ≥
 *     minDistinctTasks separate tasks before it becomes a lesson. A one-off fluke never
 *     teaches anything (the user's explicit ask: "only repeated failure patterns").
 *   - Lesson text is DETERMINISTIC (templated from the failure family), not LLM-phrased —
 *     so we never inject a hallucinated, wrong "lesson".
 *   - Injection is BOUNDED (top-K) and opt-in.
 *
 * The pure functions here (normalize / detect / build) are unit-tested; the JSONL I/O is
 * a thin wrapper.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { logger } from '../../utils/logger.js';

export interface FailureEvent {
  ts: string;
  /** Stable per-task key (so we can count DISTINCT tasks, not just raw occurrences). */
  task: string;
  tool: string;
  /** Normalized signature — the clustering key. */
  signature: string;
  /** A short raw sample for display. */
  sample: string;
}

/**
 * Reduce a tool error to a STABLE signature so the same KIND of failure clusters even
 * when the specifics differ: drop absolute paths, line:col, quoted identifiers, numbers,
 * and hex; lowercase; collapse whitespace; cap length. Keyed by the tool name.
 */
export function normalizeFailureSignature(tool: string, error: string): string {
  let s = (error || '').toLowerCase();
  s = s.replace(/[\w./-]*\/[\w./-]+/g, '<path>');     // unix-ish paths (with a slash)
  s = s.replace(/[a-z]:\\[\w\\./-]+/g, '<path>');      // windows paths
  s = s.replace(/\b[\w-]+\.[a-z][a-z0-9]{0,5}\b/g, '<path>'); // bare filenames (x.ts, y.py)
  s = s.replace(/:\d+(:\d+)?/g, '');                   // :line:col
  s = s.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "'<id>'"); // quoted identifiers
  s = s.replace(/\b0x[0-9a-f]+\b/g, '<hex>');
  s = s.replace(/\b\d+\b/g, '<n>');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.slice(0, 100);
  return `${tool}|${s}`;
}

/** A short, stable key for a task (so we count distinct tasks). */
export function taskKey(prompt: string): string {
  return createHash('sha1').update((prompt || '').trim().toLowerCase()).digest('hex').slice(0, 10);
}

export interface FailurePattern {
  signature: string;
  tool: string;
  count: number;
  /** How many DISTINCT tasks hit this. */
  distinctTasks: number;
  sample: string;
}

export interface DetectOpts { minOccurrences: number; minDistinctTasks: number }
export const DEFAULT_DETECT: DetectOpts = { minOccurrences: 3, minDistinctTasks: 2 };

/** Cluster events by signature and return only the patterns that RECUR enough to learn. */
export function detectFailurePatterns(events: FailureEvent[], opts: DetectOpts = DEFAULT_DETECT): FailurePattern[] {
  const by = new Map<string, { tool: string; count: number; tasks: Set<string>; sample: string }>();
  for (const e of events) {
    let g = by.get(e.signature);
    if (!g) { g = { tool: e.tool, count: 0, tasks: new Set(), sample: e.sample }; by.set(e.signature, g); }
    g.count++;
    g.tasks.add(e.task);
  }
  const out: FailurePattern[] = [];
  for (const [signature, g] of by) {
    if (g.count >= opts.minOccurrences && g.tasks.size >= opts.minDistinctTasks) {
      out.push({ signature, tool: g.tool, count: g.count, distinctTasks: g.tasks.size, sample: g.sample });
    }
  }
  // Most-repeated first.
  return out.sort((a, b) => b.count - a.count);
}

/** Templated, DETERMINISTIC caution for a recurring failure. Never LLM-phrased. */
export function buildLesson(p: FailurePattern): string {
  const sig = p.signature.toLowerCase();
  const verb = (advice: string) => `When using \`${p.tool}\`: ${advice} (this failed ${p.count}× across ${p.distinctTasks} tasks).`;
  if (/(not found|does not exist|cannot find|no such|unknown symbol|undefined)/.test(sig)) {
    if (p.tool.startsWith('edit_symbol')) return verb('confirm the symbol exists first (grep / code-graph) — it has repeatedly not been found.');
    return verb('verify the target exists before calling it — the target has repeatedly not been found.');
  }
  if (/(permission|denied|eacces|not permitted)/.test(sig)) return verb('check permissions / path writability before retrying.');
  if (/(timeout|timed out|etimedout)/.test(sig)) return verb('it has repeatedly timed out — narrow the scope or raise the timeout.');
  if (/(syntax|parse|unexpected token)/.test(sig)) return verb('the produced input repeatedly failed to parse — double-check syntax before submitting.');
  if (/(already exists|eexist)/.test(sig)) return verb('the target already exists — read/update it instead of creating.');
  return verb(`it has failed repeatedly with: "${p.sample.slice(0, 80)}". Check its preconditions before using it again.`);
}

/** Build the system-prompt block from confirmed patterns (top-K). Empty when none. */
export function buildLessonsBlock(patterns: FailurePattern[], topK = 5): string {
  if (patterns.length === 0) return '';
  const lines = ['# Learned cautions (from your own repeated failures)', '',
    'These mistakes have recurred across past tasks. Avoid repeating them:', ''];
  for (const p of patterns.slice(0, topK)) lines.push(`- ${buildLesson(p)}`);
  return lines.join('\n');
}

// ── I/O ──────────────────────────────────────────────────────────────────────

function failuresPath(): string {
  return path.join(os.homedir(), '.qodex', 'failures.jsonl');
}

export async function recordFailure(ev: Omit<FailureEvent, 'ts'>): Promise<void> {
  try {
    const full = failuresPath();
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.appendFile(full, JSON.stringify({ ts: new Date().toISOString(), ...ev }) + '\n', 'utf-8');
  } catch (e: any) {
    logger.debug('Failure not recorded', { err: e?.message });
  }
}

/** Read the failure log (most recent `limit` events, to bound memory). */
export async function readFailures(limit = 2000): Promise<FailureEvent[]> {
  try {
    const raw = await fs.readFile(failuresPath(), 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const slice = lines.slice(-limit);
    return slice.map(l => { try { return JSON.parse(l) as FailureEvent; } catch { return null; } }).filter(Boolean) as FailureEvent[];
  } catch {
    return [];
  }
}

/** Convenience: read → detect → build the injectable block. Used by the agent loop. */
export async function loadLessonsBlock(opts: DetectOpts & { topK?: number } = { ...DEFAULT_DETECT }): Promise<string> {
  const patterns = detectFailurePatterns(await readFailures(), opts);
  return buildLessonsBlock(patterns, opts.topK ?? 5);
}
