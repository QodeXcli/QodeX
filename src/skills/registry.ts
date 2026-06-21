/**
 * Process-wide cache of loaded skills. Refreshed once per session at start and
 * any time a skill is installed/removed/toggled. Slash-command handlers and the
 * `use_skill` tool both read from here so they see a consistent view.
 */

import { loadSkills, loadSkillState, saveSkillState } from './loader.js';
import type { SkillSpec, SkillSummary } from './types.js';

let _cache: Map<string, SkillSpec> = new Map();
let _cwd = '';

export async function initSkillRegistry(cwd: string): Promise<void> {
  _cwd = cwd;
  _cache = await loadSkills(cwd);
}

export async function refreshSkillRegistry(): Promise<void> {
  if (_cwd) _cache = await loadSkills(_cwd);
}

export function getSkill(name: string): SkillSpec | undefined {
  return _cache.get(name);
}

export function listSkills(): SkillSpec[] {
  return Array.from(_cache.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAllSkillsWithState(cwd: string): Promise<SkillSummary[]> {
  const state = await loadSkillState();
  // Re-scan from disk WITHOUT the disabled-filter to surface disabled skills in /skills listings.
  const enabled = await loadSkills(cwd);
  const seen = new Set(enabled.keys());

  const out: SkillSummary[] = [];
  for (const s of enabled.values()) {
    out.push({
      name: s.name,
      description: s.description,
      origin: s.origin,
      version: s.version,
      enabled: true,
      triggers: s.triggers,
      slashAliases: s.slashAliases,
    });
  }
  // Surface user-scope disabled skills too (read directly without the state filter).
  const { userSkillsDir, parseSkill } = await import('./loader.js');
  const { promises: fs } = await import('fs');
  const path = await import('path');
  let dirents: import('fs').Dirent[] = [];
  try { dirents = await fs.readdir(userSkillsDir(), { withFileTypes: true }); } catch { dirents = []; }
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('.') || seen.has(d.name)) continue;
    if (state[d.name]?.enabled !== false) continue;
    try {
      const raw = await fs.readFile(path.join(userSkillsDir(), d.name, 'SKILL.md'), 'utf-8');
      const spec = parseSkill(raw, d.name, path.join(userSkillsDir(), d.name), 'user');
      if (!spec) continue;
      out.push({
        name: spec.name,
        description: spec.description,
        origin: spec.origin,
        version: spec.version,
        enabled: false,
        triggers: spec.triggers,
        slashAliases: spec.slashAliases,
      });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Toggle a user-scope skill on/off. Project skills are always considered on. */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const state = await loadSkillState();
  if (enabled) {
    delete state[name];
  } else {
    state[name] = { enabled: false };
  }
  await saveSkillState(state);
  await refreshSkillRegistry();
}

/** Build the compact list-block injected into every system prompt. */
/**
 * Build the "Available Skills" system block.
 *
 * Scales with the number of installed skills:
 *   - Few skills (≤ INLINE_LIMIT): list each with its full description inline.
 *     Cheapest to reason over when the set is small.
 *   - Many skills (> INLINE_LIMIT): switch to a compact roster (name + a short
 *     description, no triggers) PLUS a note that the model can call
 *     `search_skills query="…"` to find the right one by keyword/meaning. This
 *     keeps the always-present prompt cost bounded (and the KV-cache prefix
 *     stable) even with 50+ installed skills, while still letting the model
 *     discover and load any of them.
 */
const INLINE_LIMIT = 14;

export function buildSkillsSystemBlock(): string {
  const skills = listSkills();
  if (skills.length === 0) return '';

  if (skills.length <= INLINE_LIMIT) {
    const lines = ['# Available Skills', '', 'Installed skills you can load by calling `use_skill name="<id>"`. Each is a focused playbook the user has installed — only load when the task at hand matches the description. Don\'t load more than one per turn unless needed.', ''];
    for (const s of skills) {
      const triggers = s.triggers?.length ? `  (triggers: ${s.triggers.join(', ')})` : '';
      lines.push(`- **${s.name}** — ${s.description}${triggers}`);
    }
    lines.push('');
    lines.push('Loading a skill costs ~500–2000 tokens (its full body is returned). Calling `use_skill` once at the start of a relevant turn beats guessing.');
    return lines.join('\n');
  }

  // Many skills → compact roster + search affordance.
  const lines = [
    '# Available Skills',
    '',
    `${skills.length} skills are installed. To keep context lean, only their names + a one-line summary are listed here. When a task matches, EITHER:`,
    '  - call `search_skills query="<what you need>"` to find the best skill by keyword/meaning, then',
    '  - call `use_skill name="<id>"` to load its full playbook.',
    'If you already see the right name below, skip search and call `use_skill` directly.',
    '',
  ];
  // Compact: one line each, description truncated so the roster stays bounded.
  for (const s of skills) {
    const short = s.description.length > 90 ? s.description.slice(0, 87) + '…' : s.description;
    lines.push(`- **${s.name}** — ${short}`);
  }
  lines.push('');
  lines.push('Loading a skill returns its full body (~500–2000 tokens). Search first when unsure which of the many installed skills fits.');
  return lines.join('\n');
}

/** Lightweight keyword/substring search over installed skills (for the search_skills tool). */
/**
 * Persian → English synonym layer. Installed skills carry ENGLISH names/descriptions/
 * triggers, so a Persian-only prompt substring-matches nothing and auto-inject never
 * fires — for the very audience QodeX targets. We map common Persian task words (and
 * transliterated names) to the English terms the skills actually contain, then score
 * against those too. Curated short terms (seo/ui/ux/api) bypass the min-length filter.
 */
const FA_EN_SYNONYMS: Record<string, string[]> = {
  // marketing / copy
  'تبلیغ': ['marketing', 'advertising', 'copy'], 'تبلیغاتی': ['marketing', 'advertising', 'copy'],
  'کپی': ['copy', 'copywriting'], 'کپیرایت': ['copywriting', 'copy'], 'برند': ['brand', 'marketing'],
  'فروش': ['sales', 'marketing'], 'بازاریابی': ['marketing'],
  // animation / emil kowalski
  'انیمیشن': ['animation', 'motion'], 'متحرک': ['animation', 'motion'], 'اسپرینگ': ['spring', 'animation'],
  'امیل': ['emil'], 'کوالسکی': ['kowalski'],
  // refactor / ghost
  'ریفکتور': ['refactor'], 'بازنویسی': ['refactor'], 'نامرئی': ['invisible', 'ghost'],
  // backend / frontend / api
  'بکاند': ['backend', 'api', 'server'], 'بکند': ['backend', 'api'], 'سرور': ['server', 'backend'],
  'فرانتاند': ['frontend'], 'فرانت': ['frontend'],
  // seo / geo
  'سئو': ['seo'], 'جئو': ['geo'],
  // design / ui / ux / taste
  'دیزاین': ['design', 'visual'], 'طراحی': ['design', 'visual'], 'ظاهر': ['visual', 'design'],
  'سلیقه': ['taste', 'design'], 'بصری': ['visual', 'design'], 'رابط': ['interface'],
  'تجربهکاربری': ['ux'], 'دسترسپذیری': ['accessibility'],
  // data / generative
  'داده': ['data'], 'دیتا': ['data'], 'اسکرپ': ['scrape', 'scraping'], 'جمعآوری': ['collect', 'scraping'],
  'مولد': ['generative'],
};

/** Normalize a Persian token so map keys match real prose: drop ZWNJ + the Ezafe/diacritic
 *  marks (kasra ِ, fatha, …) that get appended to words, and unify Arabic ي/ك → Persian ی/ک. */
export function normalizeFaToken(s: string): string {
  return s
    .replace(/[‌ـ]/g, '')        // ZWNJ + tatweel
    .replace(/[ً-ْ]/g, '')       // harakat/diacritics (kasra, fatha, damma, sukun…)
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک'); // Arabic → Persian letter forms
}

export function searchInstalledSkills(query: string, limit = 8): Array<{ name: string; description: string; score: number; strong: number }> {
  const q = query.toLowerCase();
  // Build effective match terms: organic words (≥3 chars) + curated Persian→English synonyms.
  const terms = new Set<string>();
  for (const raw of q.split(/\s+/).filter(Boolean)) {
    const t = normalizeFaToken(raw);
    if (t.length >= 3) terms.add(t);
    // Substring match against synonym keys handles Persian morphology — Ezafe, prefixes,
    // and compounds (e.g. "خوش‌سلیقه" contains "سلیقه", "طراحیِ" → "طراحی").
    for (const [key, vals] of Object.entries(FA_EN_SYNONYMS)) {
      if (t === key || t.includes(key)) for (const e of vals) terms.add(e);
    }
  }
  const qTerms = [...terms];
  const scored = listSkills().map(s => {
    const haystack = `${s.name} ${s.description} ${(s.triggers ?? []).join(' ')}`.toLowerCase();
    let score = 0;
    // `strong` tracks ONLY the high-signal matches (skill NAME + distinctive TRIGGERS),
    // separate from the +1 generic-word (haystack) hits that any verbose description
    // accumulates. The dominance gate uses `strong` so an obvious name/trigger match
    // (e.g. "Emil Kowalski" → emilkowalski) isn't blocked by a noisy runner-up that
    // only racked up incidental description-word overlaps.
    let strong = 0;
    for (const term of qTerms) {
      // terms are pre-filtered (organic ≥3 chars + curated synonyms), so score each directly.
      if (s.name.toLowerCase().includes(term)) { score += 5; strong += 5; }   // name match is strongest
      if ((s.triggers ?? []).some(t => t.toLowerCase().includes(term))) { score += 3; strong += 3; }
      if (haystack.includes(term)) score += 1;
    }
    return { name: s.name, description: s.description, score, strong };
  });
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Pick the single skill to AUTO-INJECT for a user prompt, or null if none is a
 * confident match. This is the just-in-time path: instead of relying on a (often
 * "dumb") model to call use_skill itself, the loop calls this at turn start and
 * puts the matched playbook in front of the model automatically.
 *
 * Deliberately conservative — injecting the wrong skill, or bloating context on a
 * weak match, is worse than injecting nothing:
 *   - top score must clear `minScore` (a real trigger/name hit, not just an
 *     incidental word in a description), and
 *   - top must DOMINATE the runner-up (`dominance`×) so an ambiguous tie injects
 *     nothing and leaves the choice to the model's own use_skill call.
 */
export function suggestSkillForPrompt(
  prompt: string,
  opts: { minScore?: number; dominance?: number } = {},
): string | null {
  return pickDominantSkill(searchInstalledSkills(prompt, 3), opts);
}

/**
 * Pure threshold decision over already-scored results (newest-first by score).
 * Returns the top skill name iff it clears `minScore` AND dominates the runner-up
 * by `dominance`×; otherwise null. Separated out so it's unit-testable without
 * touching the registry's module state.
 */
export function pickDominantSkill(
  results: Array<{ name: string; score: number; strong?: number }>,
  opts: { minScore?: number; dominance?: number } = {},
): string | null {
  const minScore = opts.minScore ?? 6;
  const dominance = opts.dominance ?? 1.5;
  if (results.length === 0) return null;
  const top = results[0];
  if (top.score < minScore) return null;
  const second = results[1];
  if (!second) return top.name;

  // High-signal win: the top skill matched on its NAME or a distinctive TRIGGER more
  // than the runner-up did. This rescues obvious picks (e.g. "Emil Kowalski" →
  // emilkowalski:strong=10) that the blunt total-score ratio would otherwise reject
  // because a verbose runner-up (e.g. data-collector) piled up incidental word hits.
  const topStrong = top.strong ?? 0;
  const secondStrong = second.strong ?? 0;
  if (topStrong >= 5 && topStrong > secondStrong) return top.name;

  // Otherwise require clear TOTAL dominance, so genuinely ambiguous prose (no decisive
  // name/trigger signal) injects nothing and defers to the model's own use_skill.
  if (top.score < second.score * dominance) return null;
  return top.name;
}

/** Compute the union of slash-aliases registered by all installed skills. */
export function slashAliasMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of listSkills()) {
    for (const alias of s.slashAliases ?? []) {
      const clean = alias.replace(/^\//, '').toLowerCase();
      if (clean && !m.has(clean)) m.set(clean, s.name);
    }
  }
  return m;
}
