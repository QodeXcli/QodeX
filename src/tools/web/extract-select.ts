/**
 * Semantic web extraction — QodeX's answer to Hermes's "truncate-and-store" (their PR #54843).
 *
 * Hermes replaced an expensive per-page LLM summarizer with POSITIONAL truncation: a page over the
 * char budget returns a head+tail window (~75/25) plus a pointer to the full text on disk. That's
 * fast and cheap — but positional. Their own eval was 3/4 on "answer present in the returned
 * window": when the relevant passage sits in the dropped MIDDLE, the agent must make an extra
 * read_file round-trip to recover it.
 *
 * We keep their win (no LLM → same speed + ~zero cost) and beat it on quality by selecting
 * passages SEMANTICALLY when the caller supplies the query it fetched the page for: rank passages
 * by lexical-semantic similarity to the query (the SAME stemmed TF-cosine + the recall machinery we
 * already ship), keep the title/lede as an anchor, and return the most relevant passages in
 * document order. The mid-document answer that costs Hermes a round-trip comes back in the first
 * response. With no query we fall back to their exact head+tail window — so we're never worse.
 *
 * PURE — deterministic, no I/O, no model. Fully unit-tested.
 */
import { termFreq, cosineSim } from '../../skills/learning/similarity.js';
import { semanticTokens } from '../../context/approach-recall.js';

export interface Passage { text: string; start: number }
export type ExtractMode = 'whole' | 'semantic' | 'head-tail';
export interface ExtractSelection {
  content: string;        // assembled, budget-bounded content (with gap markers)
  mode: ExtractMode;
  fullLength: number;     // length of the clean input
  keptChars: number;      // chars actually returned (excluding markers)
  omittedChars: number;   // fullLength - keptChars
}

/** Split clean text into passages on blank-line boundaries, keeping each one's char offset. PURE. */
export function splitPassages(text: string): Passage[] {
  const parts: Passage[] = [];
  const re = /\n[ \t]*\n/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const seg = text.slice(last, m.index);
    if (seg.trim()) parts.push({ text: seg.trim(), start: last });
    last = re.lastIndex;
  }
  const tail = text.slice(last);
  if (tail.trim()) parts.push({ text: tail.trim(), start: last });
  return parts;
}

/**
 * Replace inline base64 image blobs (`![alt](data:image/...;base64,…)`) — token bombs — with
 * `[IMAGE: alt]` placeholders. Real http(s) image links are preserved so the agent can still fetch
 * or vision-analyze them. Mirrors Hermes's convert_base64_images_to_links. PURE.
 */
export function stripBase64Images(text: string): string {
  return text.replace(/!\[([^\]]*)\]\(\s*data:image\/[^;]+;base64,[^)]*\)/gi, (_m, alt) => `[IMAGE${alt ? `: ${String(alt).trim()}` : ''}]`);
}

/** Hermes's positional fallback: a head+tail window (~75/25), snapped to line boundaries. PURE. */
export function headTailWindow(text: string, budget: number): { content: string; keptChars: number } {
  if (text.length <= budget) return { content: text, keptChars: text.length };
  const marker = budget < 400 ? 40 : 80;
  const room = Math.max(0, budget - marker);
  const headBudget = Math.floor(room * 0.75);
  const tailBudget = room - headBudget;
  let head = text.slice(0, headBudget);
  const hi = head.lastIndexOf('\n');
  if (hi > headBudget * 0.5) head = head.slice(0, hi);
  let tail = text.slice(text.length - tailBudget);
  const ti = tail.indexOf('\n');
  if (ti >= 0 && ti < tailBudget * 0.5) tail = tail.slice(ti + 1);
  const kept = head.length + tail.length;
  const omitted = text.length - kept;
  return { content: `${head.trimEnd()}\n\n[… ${omitted} chars omitted (positional) …]\n\n${tail.trimStart()}`, keptChars: kept };
}

/**
 * Choose what to return for a page that exceeds the budget. With a query, rank passages by stemmed
 * TF-cosine and return the most relevant ones (plus the lede anchor) in document order; without a
 * query, fall back to the head+tail window. PURE.
 */
export function selectRelevantPassages(text: string, opts: { query?: string; budget: number }): ExtractSelection {
  const fullLength = text.length;
  const budget = Math.max(200, opts.budget);
  if (fullLength <= budget) return { content: text, mode: 'whole', fullLength, keptChars: fullLength, omittedChars: 0 };

  const query = (opts.query ?? '').trim();
  const passages = splitPassages(text);
  const qv = query ? termFreq(semanticTokens(query)) : null;
  if (!qv || qv.size === 0 || passages.length <= 1) {
    const ht = headTailWindow(text, budget);
    return { content: ht.content, mode: 'head-tail', fullLength, keptChars: ht.keptChars, omittedChars: fullLength - ht.keptChars };
  }

  // Score every passage; always keep passage 0 (title/lede) as context anchor.
  const scored = passages.map((p, i) => ({ i, p, score: cosineSim(qv, termFreq(semanticTokens(p.text))) }));
  const chosen = new Set<number>([0]);
  let used = passages[0]!.text.length;
  for (const s of scored.filter(s => s.i !== 0 && s.score > 0).sort((a, b) => b.score - a.score)) {
    if (used + s.p.text.length + 2 > budget) continue;      // skip; a smaller relevant one may still fit
    chosen.add(s.i); used += s.p.text.length + 2;
  }
  // If the query matched nothing beyond the anchor, positional is the safer bet.
  if (chosen.size === 1 && passages.length > 1) {
    const ht = headTailWindow(text, budget);
    return { content: ht.content, mode: 'head-tail', fullLength, keptChars: ht.keptChars, omittedChars: fullLength - ht.keptChars };
  }

  // Emit chosen passages in document order, marking gaps between non-adjacent selections.
  const order = [...chosen].sort((a, b) => a - b);
  const chunks: string[] = [];
  let kept = 0; let prev = -1;
  for (const idx of order) {
    if (prev >= 0 && idx > prev + 1) {
      const gap = passages.slice(prev + 1, idx).reduce((a, p) => a + p.text.length, 0);
      chunks.push(`[… ${gap} chars omitted (less relevant) …]`);
    }
    chunks.push(passages[idx]!.text);
    kept += passages[idx]!.text.length;
    prev = idx;
  }
  if (prev < passages.length - 1) {
    const gap = passages.slice(prev + 1).reduce((a, p) => a + p.text.length, 0);
    chunks.push(`[… ${gap} chars omitted (less relevant) …]`);
  }
  return { content: chunks.join('\n\n'), mode: 'semantic', fullLength, keptChars: kept, omittedChars: fullLength - kept };
}
