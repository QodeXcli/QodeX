/**
 * Code-graph-informed skill suggestion — after a successful session, decide whether the work
 * looks like a REUSABLE pattern worth capturing as a skill, and propose a name/area for it.
 *
 * The differentiator vs. a generic "want to save this?": we read the SHAPE of the change from the
 * code graph. A focused, multi-file change cohesive within one module (its touched symbols cluster
 * together) is a repeatable capability; a sprawling or one-file edit usually isn't. This is exactly
 * the judgment a code-graph-less agent can't make.
 *
 * PURE — unit-tested. The caller computes `cohesion` from the code graph (fraction of the change
 * concentrated in one area / connected symbol cluster) and passes it in.
 */

export interface SkillSuggestionInput {
  /** The task prompt that drove the session. */
  prompt: string;
  /** Files changed this session. */
  changedFiles: string[];
  /** 0–1: how concentrated the change is (code-graph cohesion — one module / connected symbols). */
  cohesion: number;
  /** Symbols the change touched (from the code graph), for the reason text. */
  touchedSymbols?: string[];
}

export interface SkillSuggestion {
  worth: boolean;
  score: number;          // 0–1
  reason: string;
  proposedName: string;   // slug
  area: string;
}

const TASK_VERBS = ['add', 'implement', 'create', 'build', 'fix', 'refactor', 'migrate', 'wire', 'integrate', 'set up', 'setup', 'configure', 'support'];

/** The dominant 2-level directory across the changed files (the "area"). PURE. */
export function commonArea(files: string[]): string {
  const dirs = files.map(f => f.split('/').slice(0, 2).join('/')).filter(Boolean);
  if (!dirs.length) return '';
  const freq = new Map<string, number>();
  for (const d of dirs) freq.set(d, (freq.get(d) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function taskVerb(prompt: string): string | null {
  const lower = prompt.toLowerCase().trim();
  return TASK_VERBS.find(v => lower.startsWith(v) || lower.includes(` ${v} `)) ?? null;
}

/** Slug a proposed skill name from the task verb + the most salient noun-ish words. PURE. */
export function proposeSkillName(prompt: string): string {
  const words = (prompt.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(w => w.length >= 3 && !['the', 'and', 'for', 'with', 'this', 'that', 'into', 'our', 'your'].includes(w))
    .slice(0, 4);
  return words.join('-') || 'captured-skill';
}

export function suggestSkillFromSession(input: SkillSuggestionInput): SkillSuggestion {
  const area = commonArea(input.changedFiles);
  const n = input.changedFiles.length;
  const multiFile = n >= 2 && n <= 12;        // focused multi-file = a pattern, not a one-off or a sprawl
  const focused = input.cohesion >= 0.6;       // concentrated in one module / connected cluster
  const verb = taskVerb(input.prompt);
  const score = (multiFile ? 0.4 : 0) + (focused ? 0.3 : 0) + (verb ? 0.3 : 0);
  // A skill is a cross-file pattern: multi-file is a hard gate (a one-file edit is never a skill).
  const worth = multiFile && score >= 0.6;
  const symbolsBit = input.touchedSymbols?.length ? ` touching ${input.touchedSymbols.slice(0, 3).join(', ')}` : '';
  const reason = worth
    ? `A focused ${verb ?? 'change'} across ${n} file(s) in ${area || 'one area'}${symbolsBit} (cohesion ${input.cohesion.toFixed(2)}) — a repeatable pattern worth capturing as a skill.`
    : `Not a clear reusable pattern (${n} file(s), cohesion ${input.cohesion.toFixed(2)}${verb ? '' : ', no clear task verb'}).`;
  return { worth, score, reason, proposedName: proposeSkillName(input.prompt), area };
}
