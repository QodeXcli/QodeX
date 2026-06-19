import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Trellis harness integration.
 *
 * Trellis (github.com/mindfold-ai/trellis) is a *file-based* coding harness, not
 * a binary plugin: a project keeps its conventions, task PRDs, and session
 * journals as markdown under a `.trellis/` directory, and each agent reads them
 * back so context survives across sessions. The layout is:
 *
 *   .trellis/spec/        conventions, coding standards, architecture rules
 *   .trellis/tasks/       PRDs, per-task implementation/review context, status
 *   .trellis/workspace/   journals — what happened in prior sessions
 *
 * Because it's just files, QodeX doesn't need a bespoke plugin to "support"
 * Trellis — it needs to READ the directory and inject the relevant parts into
 * the system prompt, exactly the same way it injects CLAUDE.md project rules.
 * That keeps QodeX interoperable with the official Trellis CLI (and the 14 other
 * agents that read the same `.trellis/` tree) instead of inventing a parallel
 * format.
 *
 * This reader is deliberately bounded: specs in full (they're the durable
 * rules), task files trimmed to the active ones, and only the most recent
 * journal entries — so a large `.trellis/` history can't blow the context
 * window. If there's no `.trellis/` dir, this is a no-op and costs one stat.
 */

export interface TrellisContext {
  /** Rendered block to inject into the system prompt (full: spec+tasks+journals). */
  block: string;
  /** Just the conventions/spec — binding rules that even focused sub-agents follow. */
  specBlock: string | null;
  /** Where the .trellis dir was found. */
  rootDir: string;
  /** Counts for the status line / debugging. */
  counts: { specFiles: number; taskFiles: number; journalFiles: number };
}

const MAX_SPEC_BYTES = 24_000;       // specs are the point — generous
const MAX_TASK_BYTES = 16_000;       // active task context
const MAX_JOURNAL_BYTES = 12_000;    // recent history only
const MAX_JOURNAL_FILES = 3;         // newest N journals

/** Find the nearest ancestor dir that contains a `.trellis/` folder. */
async function findTrellisRoot(cwd: string): Promise<string | null> {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (true) {
    try {
      const st = await fs.stat(path.join(dir, '.trellis'));
      if (st.isDirectory()) return dir;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }
  return null;
}

/** Read every markdown file directly under `dir` (one level), oldest→newest by name. */
async function readMarkdownDir(dir: string): Promise<Array<{ name: string; content: string; mtimeMs: number }>> {
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }))
      .filter(e => e.isFile() && /\.(md|markdown|txt)$/i.test(e.name))
      .map(e => e.name);
  } catch {
    return [];
  }
  const out: Array<{ name: string; content: string; mtimeMs: number }> = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const [content, st] = await Promise.all([
        fs.readFile(full, 'utf-8'),
        fs.stat(full),
      ]);
      out.push({ name, content: content.trim(), mtimeMs: st.mtimeMs });
    } catch { /* skip unreadable */ }
  }
  return out;
}

/** Concatenate files under a byte budget, marking truncation. */
function packFiles(
  files: Array<{ name: string; content: string }>,
  budget: number,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const f of files) {
    if (used >= budget) { parts.push(`… (${files.length - parts.length} more file(s) omitted)`); break; }
    const remaining = budget - used;
    const body = f.content.length > remaining
      ? f.content.slice(0, remaining) + '\n… (truncated)'
      : f.content;
    parts.push(`### ${f.name}\n${body}`);
    used += body.length + f.name.length + 8;
  }
  return parts.join('\n\n');
}

/**
 * Load and render the Trellis context block for `cwd`. Returns null when there's
 * no `.trellis/` directory (the common case for non-Trellis projects).
 */
export async function loadTrellisContext(cwd: string): Promise<TrellisContext | null> {
  const rootDir = await findTrellisRoot(cwd);
  if (!rootDir) return null;
  const base = path.join(rootDir, '.trellis');

  const [spec, tasks, journalsAll] = await Promise.all([
    readMarkdownDir(path.join(base, 'spec')),
    readMarkdownDir(path.join(base, 'tasks')),
    readMarkdownDir(path.join(base, 'workspace')),
  ]);

  // Specs: alphabetical (stable). Tasks: alphabetical. Journals: newest first, capped.
  spec.sort((a, b) => a.name.localeCompare(b.name));
  tasks.sort((a, b) => a.name.localeCompare(b.name));
  const journals = journalsAll
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_JOURNAL_FILES);

  if (spec.length === 0 && tasks.length === 0 && journals.length === 0) {
    return null; // .trellis exists but is empty — nothing to inject
  }

  const sections: string[] = [];
  sections.push(
    `## Trellis project harness\n` +
    `This project uses Trellis (.trellis/). Treat the spec below as binding ` +
    `conventions, the tasks as the current work and its status, and the journals ` +
    `as what happened in prior sessions. Follow the spec; continue the tasks; do ` +
    `not re-derive decisions already recorded in the journals. When you finish a ` +
    `unit of work or context fills up, update the relevant task status and append ` +
    `a short journal entry under .trellis/workspace/.`,
  );

  if (spec.length > 0) {
    sections.push(`### Conventions (.trellis/spec/)\n${packFiles(spec, MAX_SPEC_BYTES)}`);
  }
  if (tasks.length > 0) {
    sections.push(`### Tasks (.trellis/tasks/)\n${packFiles(tasks, MAX_TASK_BYTES)}`);
  }
  if (journals.length > 0) {
    sections.push(
      `### Recent journals (.trellis/workspace/, newest first)\n` +
      packFiles(journals, MAX_JOURNAL_BYTES),
    );
  }

  const specBlock = spec.length > 0
    ? `## Trellis conventions (.trellis/spec/) — binding\n${packFiles(spec, MAX_SPEC_BYTES)}`
    : null;

  return {
    block: sections.join('\n\n'),
    specBlock,
    rootDir,
    counts: { specFiles: spec.length, taskFiles: tasks.length, journalFiles: journals.length },
  };
}
