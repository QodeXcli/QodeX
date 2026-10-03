/**
 * Light user model — "what QodeX knows about you", synthesized from the user-scoped facts you've
 * taught it plus the themes of your recent tasks. Our answer to a dialectic user model, but
 * deterministic and transparent: no hidden LLM profile, just an aggregation you can read (and
 * correct via /memory). Surfaced by `qodex whoami` and the dashboard.
 *
 * All PURE — unit-tested.
 */

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are', 'was', 'has',
  'have', 'will', 'can', 'should', 'add', 'fix', 'make', 'use', 'using', 'get', 'set', 'run', 'new',
  'all', 'any', 'how', 'why', 'what', 'when', 'where', 'a', 'an', 'to', 'of', 'in', 'on', 'it', 'is',
  'be', 'do', 'so', 'or', 'if', 'my', 'me', 'we', 'our', 'qodex', 'please', 'want', 'need', 'like',
]);

export interface UserModel {
  preferences: string[];
  recentThemes: string[];
  /** Directories the user works in most, from the files their tasks touched. */
  favoriteAreas: string[];
  taskCount: number;
  summary: string;
}

/** Top recurring content words across recent task prompts (≥3 chars, not stopwords). PURE. */
export function extractThemes(prompts: string[], topK = 6): string[] {
  const freq = new Map<string, number>();
  for (const p of prompts) {
    for (const tok of (p.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])) {
      if (STOP.has(tok)) continue;
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, n]) => n >= 2)              // a theme recurs, not a one-off
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topK)
    .map(([w]) => w);
}

/** Directories the user works in most, from the files their episodes touched (2-level). PURE. */
export function favoriteAreas(fileLists: string[][], topK = 3): string[] {
  const freq = new Map<string, number>();
  for (const files of fileLists) for (const f of files) {
    const area = f.split('/').slice(0, 2).join('/');
    if (area) freq.set(area, (freq.get(area) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topK).map(([a]) => a);
}

export function buildUserModel(input: { userFacts: string[]; episodes: { prompt: string; files?: string[] }[] }): UserModel {
  const preferences = input.userFacts
    .map(f => f.replace(/!important\b/gi, '').replace(/^\s*[\-*]\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const recentThemes = extractThemes(input.episodes.map(e => e.prompt));
  const areas = favoriteAreas(input.episodes.map(e => e.files ?? []));
  const bits: string[] = [];
  if (preferences.length) bits.push(`${preferences.length} stated preference${preferences.length === 1 ? '' : 's'}`);
  if (recentThemes.length) bits.push(`recent focus: ${recentThemes.slice(0, 3).join(', ')}`);
  if (areas.length) bits.push(`works mostly in ${areas[0]}`);
  return {
    preferences,
    recentThemes,
    favoriteAreas: areas,
    taskCount: input.episodes.length,
    summary: bits.length ? bits.join(' · ') : 'Nothing learned about you yet.',
  };
}

/** A readable block for `qodex whoami` / the dashboard. PURE. */
export function renderUserModel(m: UserModel): string {
  const lines = ['# What QodeX knows about you', ''];
  lines.push(`Tasks recorded: ${m.taskCount}`);
  if (m.preferences.length) { lines.push('', 'Preferences (you told me):'); for (const p of m.preferences) lines.push(`  • ${p}`); }
  else lines.push('', 'No stated preferences yet — tell me with `remember` / `/memory`.');
  if (m.recentThemes.length) lines.push('', `Recent focus: ${m.recentThemes.join(', ')}`);
  if (m.favoriteAreas.length) lines.push(`Works mostly in: ${m.favoriteAreas.join(', ')}`);
  return lines.join('\n');
}
