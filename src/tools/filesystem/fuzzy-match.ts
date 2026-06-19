/**
 * Resilient text matching for the `edit_text` tool.
 *
 * The model frequently produces an `old_string` that is ALMOST right but not
 * byte-exact: a tab where the file has spaces, a trailing space stripped, CRLF
 * vs LF, or one indentation level off because it reconstructed the snippet from
 * memory. A strict `indexOf` fails on all of these, and the turn burns an
 * iteration on a re-read.
 *
 * This module adds a tiered match strategy, fastest-first, stopping at the first
 * tier that yields a unique, confident match:
 *
 *   Tier 0 — EXACT. Plain substring. O(n). The common case; zero risk.
 *   Tier 1 — LINE-TRIMMED. Compare line-by-line ignoring leading/trailing
 *            whitespace and normalizing CRLF→LF. Catches indentation drift and
 *            line-ending mismatches. The replacement is re-indented to match the
 *            file's actual leading whitespace so output stays clean.
 *   Tier 2 — FUZZY ANCHOR. Slide a window of the search's line-count over the
 *            file and score each position by normalized similarity (token-level
 *            Jaccard on trimmed lines, which is cheap and robust to small
 *            within-line edits). Accept only if the best score clears a high
 *            threshold AND beats the runner-up by a margin (so we never apply an
 *            ambiguous match).
 *
 * Every tier reports HOW it matched so the caller can surface it ("matched with
 * whitespace normalization") — transparency matters when we're being lenient
 * about what the model asked for.
 *
 * Safety: fuzzy tiers require the match to be UNIQUE-enough. If two windows tie,
 * we refuse and ask for more context rather than guess. We never fuzzy-match
 * very short search strings (< 2 non-blank lines) — too easy to hit the wrong
 * place.
 */

export type MatchTier = 'exact' | 'whitespace' | 'fuzzy';

export interface MatchResult {
  /** Char offset where the match starts in the original content. */
  start: number;
  /** Char offset where the match ends. */
  end: number;
  /** The exact original text occupying [start, end) — what we will replace. */
  matched: string;
  tier: MatchTier;
  /** For fuzzy: similarity score 0..1. */
  score?: number;
  /** Number of equally-good matches found (>1 ⇒ ambiguous, caller should reject). */
  occurrences: number;
}

function normLine(s: string): string {
  return s.replace(/\r$/, '').trim();
}

function tokens(s: string): string[] {
  return normLine(s).split(/\s+/).filter(Boolean);
}

/** Token-level Jaccard similarity of two lines (1 = identical token sets). */
function lineSim(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Mean similarity between two equal-length line arrays. */
function blockSim(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += lineSim(a[i]!, b[i]!);
  // Penalize length mismatch.
  const lenPenalty = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return (sum / n) * lenPenalty;
}

/** Convert a [startLine,endLine) line range to char offsets in `content`. */
function lineRangeToOffsets(lineStarts: number[], content: string, startLine: number, endLine: number): { start: number; end: number } {
  const start = lineStarts[startLine] ?? 0;
  const end = endLine < lineStarts.length ? lineStarts[endLine]! - 1 /* drop the joining \n */ : content.length;
  return { start, end };
}

/** Precompute the char offset at which each line begins. */
function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * Find `search` in `content`, tolerating whitespace and small drift.
 * Returns null if no confident match. The threshold/margin guard fuzzy tier.
 */
export function findMatch(
  content: string,
  search: string,
  opts: { fuzzyThreshold?: number; fuzzyMargin?: number; allowFuzzy?: boolean } = {},
): MatchResult | null {
  const fuzzyThreshold = opts.fuzzyThreshold ?? 0.85;
  const fuzzyMargin = opts.fuzzyMargin ?? 0.08;
  const allowFuzzy = opts.allowFuzzy ?? true;

  // ── Tier 0: exact ──
  {
    const first = content.indexOf(search);
    if (first !== -1) {
      const occurrences = content.split(search).length - 1;
      return { start: first, end: first + search.length, matched: search, tier: 'exact', occurrences };
    }
  }

  const contentLines = content.split('\n');
  const searchLines = search.split('\n');
  // Drop a trailing empty line from a search that ended in \n.
  if (searchLines.length > 1 && searchLines[searchLines.length - 1] === '') searchLines.pop();
  const nSearch = searchLines.length;
  const lineStarts = computeLineStarts(content);

  // ── Tier 1: line-trimmed exact ──
  {
    const normSearch = searchLines.map(normLine);
    const matches: number[] = [];
    for (let i = 0; i + nSearch <= contentLines.length; i++) {
      let ok = true;
      for (let j = 0; j < nSearch; j++) {
        if (normLine(contentLines[i + j]!) !== normSearch[j]) { ok = false; break; }
      }
      if (ok) matches.push(i);
    }
    if (matches.length >= 1) {
      const i = matches[0]!;
      const { start, end } = lineRangeToOffsets(lineStarts, content, i, i + nSearch);
      return {
        start, end,
        matched: content.slice(start, end),
        tier: 'whitespace',
        occurrences: matches.length,
      };
    }
  }

  // ── Tier 2: fuzzy anchor (only when the block is substantial) ──
  const nonBlank = searchLines.filter(l => normLine(l).length > 0).length;
  if (!allowFuzzy || nonBlank < 2) return null;

  let best = { score: -1, index: -1 };
  let second = { score: -1, index: -1 };
  for (let i = 0; i + nSearch <= contentLines.length; i++) {
    const window = contentLines.slice(i, i + nSearch);
    const score = blockSim(window, searchLines);
    if (score > best.score) {
      second = best;
      best = { score, index: i };
    } else if (score > second.score) {
      second = { score, index: i };
    }
  }

  if (best.index >= 0 && best.score >= fuzzyThreshold && (best.score - second.score) >= fuzzyMargin) {
    const { start, end } = lineRangeToOffsets(lineStarts, content, best.index, best.index + nSearch);
    return {
      start, end,
      matched: content.slice(start, end),
      tier: 'fuzzy',
      score: best.score,
      occurrences: 1,
    };
  }

  return null;
}

/**
 * Re-indent `replacement` so its base indentation matches the indentation of
 * the text it's replacing. When the model's old_string was under-indented (and
 * matched via the whitespace tier), naively inserting its new_string would put
 * the replacement at the wrong indent level. We compute the indent delta from
 * the FIRST non-blank line of the matched block vs the search, and apply it.
 */
export function reindentReplacement(matched: string, search: string, replacement: string): string {
  const firstIndent = (s: string): string => {
    for (const line of s.split('\n')) {
      if (line.trim().length > 0) return line.slice(0, line.length - line.trimStart().length);
    }
    return '';
  };
  const matchedIndent = firstIndent(matched);
  const searchIndent = firstIndent(search);
  if (matchedIndent === searchIndent) return replacement;

  // Shift every line of the replacement by the delta.
  const replLines = replacement.split('\n');
  return replLines.map(line => {
    if (line.trim().length === 0) return line;
    // Strip the search's base indent if present, then prepend the matched indent.
    const stripped = line.startsWith(searchIndent) ? line.slice(searchIndent.length) : line.trimStart();
    return matchedIndent + stripped;
  }).join('\n');
}
