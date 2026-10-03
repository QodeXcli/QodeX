/**
 * `/learn [name]` — turn the task you just finished into a reusable skill, now.
 *
 * The automatic flywheel (capture.ts / distill.ts) only captures objectively verified
 * sessions and quarantines the result as a candidate. `/learn` is the human saying "this
 * is worth keeping": it distills the latest task of the current session (its request, the
 * ordered tool steps, what changed, the final answer) with the same deterministic
 * distiller, then promotes it straight to an active user skill — through the same
 * promoteCandidate guard, so a human-written skill of that name is never overwritten.
 */
import { distillDraft, type SessionDigest } from './distill.js';
import { writeCandidate, promoteCandidate } from './candidate-store.js';
import { skillIdFromPrompt } from './capture.js';

/** The slice of a session message this needs (session/store Message is compatible). */
export interface LearnMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
}

/** Tools whose path arguments count as "files changed". */
const WRITE_TOOLS = new Set(['write_file', 'edit_text', 'multi_edit', 'multi_file_edit', 'edit_symbol', 'safe_rename', 'csv_write']);

/** Injected turns that are not the user's own request. */
const INJECTED_RE = /^\s*\[(?:STANDING GOAL|AUTONOMOUS_MODE|CONTINUITY|SYSTEM|STEER)/;

function parseArgs(raw: string): Record<string, unknown> {
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}

/** Build a digest of the LATEST task in `messages` (from the last real user request). PURE. */
export function digestLatestTask(messages: readonly LearnMessage[]): SessionDigest | null {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim() && !INJECTED_RE.test(m.content)) { start = i; break; }
  }
  if (start < 0) return null;
  const prompt = String(messages[start]!.content).trim();
  const toolSequence: string[] = [];
  const files = new Set<string>();
  let finalSummary = '';
  for (const m of messages.slice(start + 1)) {
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) {
        const name = tc.function?.name;
        if (!name) continue;
        toolSequence.push(name);
        if (WRITE_TOOLS.has(name)) {
          const a = parseArgs(tc.function.arguments);
          for (const k of ['path', 'file_path', 'file', 'to']) if (typeof a[k] === 'string') files.add(a[k] as string);
          if (Array.isArray(a.files)) for (const f of a.files) if (typeof f === 'string') files.add(f); else if (f && typeof (f as any).path === 'string') files.add((f as any).path);
        }
      }
      if (typeof m.content === 'string' && m.content.trim()) finalSummary = m.content.trim();
    }
  }
  return { prompt, finalSummary, toolSequence, filesChanged: [...files] };
}

export interface LearnResult {
  ok: boolean;
  name?: string;
  dest?: string;
  message: string;
}

/** Sanitize a user-given skill name to the kebab id the loader expects. PURE. */
export function learnSkillName(requested: string | undefined, prompt: string): string {
  const fromUser = (requested ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return fromUser || skillIdFromPrompt(prompt);
}

/** Distill the latest task and install it as an active skill. */
export async function learnFromSession(
  messages: readonly LearnMessage[],
  cwd: string,
  opts: { name?: string; nowIso?: string } = {},
): Promise<LearnResult> {
  const digest = digestLatestTask(messages);
  if (!digest) return { ok: false, message: 'Nothing to learn yet — finish a task first, then run /learn.' };
  const draft = distillDraft(digest, { nowIso: opts.nowIso ?? new Date().toISOString(), policy: { minSteps: 2, filesOptional: true } });
  if (!draft) return { ok: false, message: 'The last task was too short to make a skill from (it needs at least two distinct steps).' };
  const name = learnSkillName(opts.name, digest.prompt);
  const skillMd = draft.skillMd
    .replace(/^name: .*$/m, `name: ${name}`)
    .replace(/^# .*$/m, `# ${name}`)
    .replace(/^> Draft skill distilled .*$/m, '> Skill captured with /learn from a task you approved.')
    .replace(/^> \*\*Candidate\*\*.*$/m, '> Edit it freely — your edits protect it from later automatic overwrites.')
    .replace(/^> Review the step outline below.*\n?/m, '');
  await writeCandidate({ name, description: draft.description, skillMd });
  const res = await promoteCandidate(name, cwd);
  if (!res.promoted) return { ok: false, name, message: `Not installed: ${res.reason}. The draft is kept as a candidate (qodex skill promote ${name}).` };
  return { ok: true, name, dest: res.dest, message: `Learned skill "${name}" (${draft.steps.length} steps) → ${res.dest}. Use it with /${name} or /skill ${name}.` };
}
