/**
 * Decide whether (and how) to emit the agent loop's `final` text after we've
 * already been streaming `text_delta` chunks to the terminal.
 *
 * Background: the agent loop emits two related signals at end-of-turn:
 *   1. a stream of `text_delta` events (already filtered through StreamDisplayFilter
 *      and printed to stdout incrementally), and
 *   2. one `final` event with the assistant's full raw text.
 *
 * In the common case those two represent the same content, and naively printing
 * `final` would duplicate everything. The OLD logic dedup'd by exact string equality;
 * when normalization diverged between the streaming and final paths (e.g. the streaming
 * filter dropped leading whitespace, but the final-text normalizer didn't), the compare
 * failed and CASE D — "diverged, print final fresh" — fired, dumping the full final
 * markdown ON TOP of what the user already saw. Most visible when parallel sub-agents
 * finished close together: the timing exposed the filter divergence repeatedly.
 *
 * Fix: compare under a whitespace-collapsed normalization so the common drift no longer
 * trips dedup; AND on genuine divergence, refuse to re-print on top — close the line
 * and stop. The Ink UI takes the same stance (its `final` handler is a no-op because
 * `thinking_done` already committed the text to history).
 */
import { StreamDisplayFilter, extractThinking, stripLeakedToolTags } from '../../llm/thinking.js';

export interface FinalDedupeDecision {
  /** Text to write to stdout. Empty string when nothing should be printed. */
  emit: string;
  /** True if the caller should write a closing newline when not already at line-start. */
  closeLine: boolean;
}

const cleanForDisplay = (s: string) => stripLeakedToolTags(extractThinking(s).visibleText);
const normCompare = (s: string) => cleanForDisplay(s).replace(/\s+/g, ' ').trim();

export function dedupeFinalAgainstStreamed(rawFinal: string, streamedThisTurn: string): FinalDedupeDecision {
  const finalContent = cleanForDisplay(rawFinal ?? '');
  const finalCmp = normCompare(rawFinal ?? '');
  const shownCmp = normCompare(streamedThisTurn ?? '');

  // (a) Nothing in final: just close the line if we streamed anything.
  if (!finalContent) {
    return { emit: '', closeLine: !!streamedThisTurn };
  }

  // (b) Nothing was streamed (some backends emit ONLY `final`): print final fresh.
  if (!shownCmp) {
    return { emit: finalContent, closeLine: true };
  }

  // (c) Already streamed (modulo whitespace): close the line, emit nothing.
  if (finalCmp === shownCmp) {
    return { emit: '', closeLine: true };
  }

  // (d) Streamed a prefix; print the remaining suffix.
  if (finalCmp.startsWith(shownCmp)) {
    const suffixLen = finalCmp.length - shownCmp.length;
    const remainder = finalContent.slice(finalContent.length - suffixLen);
    return { emit: remainder, closeLine: true };
  }

  // (e) Divergence (filter drift, sub-agent timing, etc). DO NOT re-print — this
  // was the duplication bug. Close the line and stop.
  return { emit: '', closeLine: true };
}

/**
 * Detect whether a newly-produced assistant message is redundant against the
 * previous one IN THE SAME TURN. Some models re-emit their whole answer after a
 * tool round (or twice in a row), which the interactive UI would otherwise show
 * as two identical blocks. Returns true when `next` should be suppressed.
 *
 * Redundant means: identical (modulo whitespace), or one fully contains the
 * other (a re-emit that added/dropped some lines). Short messages (< 40
 * normalized chars) are never treated as redundant — "ok", "done", repeated
 * acknowledgements are legitimately fine to show twice.
 *
 * For the containment case we require (a) the shorter string to be substantial
 * on its own (>= 100 normalized chars, so a stray short sentence that happens to
 * appear inside a long answer isn't suppressed), AND (b) the shared block to be
 * at least 60% of the longer string (so a re-emit that merely tacked on a
 * trailing question still counts, but a long answer that only quotes a short
 * earlier line does not).
 */
export function isRedundantAssistantText(prev: string, next: string): boolean {
  const a = normCompare(prev ?? '');
  const b = normCompare(next ?? '');
  if (!a || !b) return false;
  if (b.length < 40) return false; // don't suppress short acks
  if (a === b) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];

  // Fast path: exact containment (byte-identical re-emit, possibly with extra lines).
  if (longer.includes(shorter) && shorter.length >= 100 && shorter.length >= longer.length * 0.6) {
    return true;
  }

  // Tolerant path: a re-emitted answer is rarely byte-identical — the model
  // REGENERATES it with minor wording changes (or truncates it when it runs out
  // of budget), so exact containment misses it and the user sees the whole answer
  // twice. Mirror dedupeSelfRepeatedText: measure the shared LEADING word run. A
  // genuine re-emit shares a long identical opening; two genuinely different
  // assistant messages diverge almost immediately even when they reuse topic
  // vocabulary, so this stays conservative.
  const wa = a.split(' ');
  const wb = b.split(' ');
  const minLen = Math.min(wa.length, wb.length);
  if (minLen < 30) return false; // too short to be a duplicated full answer
  let common = 0;
  while (common < minLen && wa[common] === wb[common]) common++;
  const sharedRatio = common / minLen;
  return common >= 30 && sharedRatio >= 0.6;
}

/**
 * Collapse a block of text that contains its own answer twice. Some local models
 * (re-)emit their entire response a second time within a SINGLE streamed turn —
 * so the duplication lives inside ONE assistant block, not across two, and the
 * cross-block dedupe in the UI never sees a boundary to compare.
 *
 * Strategy: look for a substantial prefix that repeats verbatim later in the
 * string. Concretely, if the text can be split into [head][tail] where `head` is
 * substantial (>= 200 normalized chars) and `tail` STARTS WITH `head` (modulo
 * whitespace), the model restarted its answer — keep only the second, more
 * complete copy (the restart is usually the fuller one) or the first if they're
 * equal length. Returns the de-duplicated text, or the input unchanged when no
 * clean self-repeat is found.
 *
 * Conservative by design: only fires on a clear verbatim restart of a large
 * block, never on incidental repetition of a sentence or a heading.
 */
export function dedupeSelfRepeatedText(text: string): string {
  const raw = text ?? '';
  if (raw.length < 400) return raw; // too short to contain a full double-answer

  // Find candidate restart points: a later occurrence of the text's own opening.
  // Use the first ~60 non-space chars as a fingerprint of the answer's start.
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const head = raw.slice(0, Math.min(raw.length, 4000));
  const fpLen = 60;
  const fingerprint = norm(head).slice(0, fpLen);
  if (fingerprint.length < fpLen) return raw;

  // Search for the fingerprint appearing AGAIN after the first ~quarter of text.
  const normFull = norm(raw);
  const secondIdxNorm = normFull.indexOf(fingerprint, Math.floor(normFull.length * 0.25));
  if (secondIdxNorm === -1) return raw;

  // Map the normalized split point back to a raw offset by walking raw and
  // counting normalized chars. Cheaper approach: split raw on a literal search of
  // the original (un-normalized) opening line, which is what actually repeats.
  const openingLine = raw.split('\n').find(l => l.trim().length >= 12)?.trim();
  if (!openingLine) return raw;
  const firstAt = raw.indexOf(openingLine);
  const secondAt = raw.indexOf(openingLine, firstAt + openingLine.length);
  if (secondAt === -1) return raw;

  const first = raw.slice(firstAt, secondAt).trim();
  const second = raw.slice(secondAt).trim();
  // Confirm it's a real restart. The two copies are often NOT byte-identical —
  // e.g. the first ends with "Would you like me to…?" and the second doesn't, or
  // one is truncated. So instead of requiring exact containment, measure how much
  // of a shared opening they have: split each into normalized words and count the
  // common leading run. A genuine re-emit shares a long prefix; two different
  // sections that merely reuse one opening line diverge almost immediately.
  const ns = norm(first), nl = norm(second);
  if (ns.length < 200 || nl.length < 200) return raw;
  const wa = ns.split(' ');
  const wb = nl.split(' ');
  let common = 0;
  const max = Math.min(wa.length, wb.length);
  while (common < max && wa[common] === wb[common]) common++;
  // Require the shared opening run to be at least 60% of the shorter copy's word
  // count — strong evidence the model restarted the same answer, tolerant of a
  // differing tail.
  const sharedRatio = common / Math.min(wa.length, wb.length);
  if (common >= 30 && sharedRatio >= 0.6) {
    // Keep the prefix before the first copy (if any) + the longer single copy.
    const preamble = raw.slice(0, firstAt).trim();
    const body = first.length >= second.length ? first : second;
    return preamble ? `${preamble}\n\n${body}` : body;
  }
  return raw;
}

// Re-export so the headless module can keep its single import surface.
export { StreamDisplayFilter };
