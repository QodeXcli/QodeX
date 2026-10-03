/**
 * Recall visualization — make `recall_approach` answers SCANNABLE: instead of a flat list of past
 * approaches, show the TOP approach in full and then a compact DIFF of each alternative against it
 * — what stayed the same across attempts (the stable core of "how we do this here") and what each
 * one did differently (the variation worth knowing about). Plus per-approach score and file links.
 *
 * Two diff modes, picked automatically:
 *   - term diff (default) — approach texts are usually short prose (prompt + summary), so a
 *     line diff is useless; instead compare VOCABULARY by stem (paginate↔pagination match) while
 *     displaying the original surface words. Yields `= shared` / `+ adds` / `− lacks` lines.
 *   - line diff (LCS)     — when BOTH texts are genuinely multi-line (worklog entries), a classic
 *     unified-style ± block is clearer.
 *
 * PURE — no I/O, no clock. Fully unit-tested; the recall tool is the thin shell.
 */
import { tokenize } from '../skills/learning/similarity.js';
import { stem, type ApproachMatch } from './approach-recall.js';

export interface TermDiff { shared: string[]; added: string[]; missing: string[] }

/** Map stem → first surface form, preserving first-seen order. */
function surfaceByStem(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const w of tokenize(text)) {
    const s = stem(w);
    if (!m.has(s)) m.set(s, w);
  }
  return m;
}

/** Vocabulary diff of `other` against `ref`, compared by stem, displayed as surface words. PURE. */
export function termDiff(refText: string, otherText: string, cap = 8): TermDiff {
  const ref = surfaceByStem(refText);
  const other = surfaceByStem(otherText);
  const shared: string[] = [], added: string[] = [], missing: string[] = [];
  for (const [s, w] of other) (ref.has(s) ? shared : added).push(w);
  for (const [s, w] of ref) if (!other.has(s)) missing.push(w);
  return { shared: shared.slice(0, cap), added: added.slice(0, cap), missing: missing.slice(0, cap) };
}

/** Classic LCS line diff → unified-style lines ('  ctx' / '- old' / '+ new'). PURE. */
export function lineDiff(a: string, b: string): string[] {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  // LCS table (texts here are small — worklog entries, not files).
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i]![j] = A[i] === B[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(`  ${A[i]}`); i++; j++; }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) { out.push(`- ${A[i]}`); i++; }
    else { out.push(`+ ${B[j]}`); j++; }
  }
  while (i < n) out.push(`- ${A[i++]}`);
  while (j < m) out.push(`+ ${B[j++]}`);
  return out;
}

/** Terms (surface forms) whose stem appears in EVERY text — the stable core of the approach. PURE. */
export function commonCore(texts: string[], cap = 8): string[] {
  if (!texts.length) return [];
  const maps = texts.map(surfaceByStem);
  const out: string[] = [];
  for (const [s, w] of maps[0]!) {
    if (maps.every(m => m.has(s))) out.push(w);
    if (out.length >= cap) break;
  }
  return out;
}

const isMultiline = (t: string): boolean => t.split('\n').filter(l => l.trim()).length >= 3;

function head(text: string, max = 160): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function tag(m: ApproachMatch): string {
  const base = m.kind === 'episode' ? '🎯 task' : m.kind === 'fact' ? '🧠 fact' : m.kind === 'receipt' ? '🧾 receipt' : `📝 ${m.detail ?? 'worklog'}`;
  // Ground-truth outcome, when known: ✓ = gates/receipt proved it worked; ⛔ = it was blocked.
  return m.verified === true ? `${base} ✓` : m.verified === false ? `${base} ⛔` : base;
}

function fileLinks(files: string[] | undefined, refFiles?: Set<string>): string {
  if (!files?.length) return '';
  const shown = files.slice(0, 4).map(f => (refFiles && !refFiles.has(f) ? `+${f}` : f));
  return `   files: ${shown.join(', ')}${files.length > 4 ? ` (+${files.length - 4})` : ''}`;
}

/**
 * A compact chronological timeline of the matched approaches — oldest → newest, so the EVOLUTION
 * of how this problem was attacked reads at a glance. Entries without a parseable timestamp are
 * skipped; capped at `k` (default 5, per the "last 5 approaches with dates" spec). PURE.
 */
export function renderTimeline(matches: ApproachMatch[], k = 5): string[] {
  const dated = matches
    .map(m => ({ m, t: m.at ? Date.parse(m.at) : NaN }))
    .filter(x => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t)
    .slice(-k);
  if (dated.length < 2) return [];
  const lines = ['', `Timeline (oldest → newest):`];
  dated.forEach(({ m }, i) => {
    const date = m.at!.slice(0, 10);
    const glyph = i === dated.length - 1 ? '●' : '○';
    const mark = m.verified === true ? ' ✓' : m.verified === false ? ' ⛔' : '';
    lines.push(`  ${glyph} ${date}${mark}  ${head(m.text, 76)}`);
  });
  return lines;
}

/**
 * Render top-K matches as a visual comparison: the best approach in full, then each alternative
 * diffed against it, then the common core across all — and a chronological timeline so the
 * evolution of the approach reads at a glance. PURE. Falls back to a plain list note when
 * there's only one match (nothing to diff).
 */
export function renderApproachDiffs(query: string, matches: ApproachMatch[], opts: { topK?: number } = {}): string {
  if (matches.length === 0) return `No past work on this project resembles "${query}".`;
  const top = matches.slice(0, opts.topK ?? 4);
  const ref = top[0]!;
  const lines: string[] = [`How you approached similar work before — "${query}":`, ''];

  lines.push(`★ Best match  [${tag(ref)} · ${ref.when} · ${Math.round(ref.score * 100)}% match]`);
  lines.push(`   ${head(ref.text)}`);
  const rf = fileLinks(ref.files);
  if (rf) lines.push(rf);

  if (top.length > 1) {
    lines.push('', 'How the other attempts DIFFERED from it:');
    const refFiles = new Set(ref.files ?? []);
    top.slice(1).forEach((m, i) => {
      lines.push('', `${i + 2}. [${tag(m)} · ${m.when} · ${Math.round(m.score * 100)}% match]  ${head(m.text, 100)}`);
      if (isMultiline(ref.text) && isMultiline(m.text)) {
        lines.push('   ```diff', ...lineDiff(ref.text, m.text).slice(0, 14).map(l => '   ' + l), '   ```');
      } else {
        const d = termDiff(ref.text, m.text);
        if (d.added.length) lines.push(`   + this one adds: ${d.added.join(', ')}`);
        if (d.missing.length) lines.push(`   − it lacks: ${d.missing.join(', ')}`);
        if (!d.added.length && !d.missing.length) lines.push('   ≈ same approach, different occasion');
      }
      const fl = fileLinks(m.files, refFiles);
      if (fl) lines.push(fl.replace('files:', 'files (+ = not in best match):'));
    });

    const core = commonCore(top.map(m => m.text));
    if (core.length >= 2) lines.push('', `Stable core across all ${top.length}: ${core.join(', ')} — this is how you consistently approach it here.`);
  }
  lines.push(...renderTimeline(top));
  return lines.join('\n');
}
