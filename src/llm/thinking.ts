/**
 * Thinking-block extractor.
 *
 * Qwen3-Coder-Next and several other reasoning-tuned models can emit
 * `<thinking>...</thinking>` blocks before their final answer or tool calls.
 * These are the model's internal reasoning — useful for the user to see
 * (transparency, "why did it pick that approach?") but should NOT be sent
 * back as part of the conversation history because:
 *
 *   1. They eat context window for no payoff (the model can re-reason).
 *   2. They include the model's mistakes/dead-ends that we shouldn't seed
 *      the next turn with.
 *   3. They confuse smaller models that learn to mimic the format.
 *
 * Strategy:
 *   - Strip the blocks from the text that goes into message history.
 *   - Surface them to the UI as a separate "thinking" event so the user can
 *     toggle visibility.
 *   - Preserve everything else (text + tool calls) untouched.
 *
 * Supported tags (case-insensitive, multiline):
 *   <thinking>...</thinking>
 *   <think>...</think>
 *   <reasoning>...</reasoning>
 *   <reflection>...</reflection>
 */

const THINKING_TAG_RE = /<(thinking|think|reasoning|reflection)>([\s\S]*?)<\/\1>/gi;

export interface ThinkingExtraction {
  /** The original text with thinking blocks removed. */
  visibleText: string;
  /** Each extracted block, in order of appearance. */
  thinkingBlocks: string[];
}

export function extractThinking(text: string): ThinkingExtraction {
  if (!text || !text.includes('<')) return { visibleText: text, thinkingBlocks: [] };
  const blocks: string[] = [];
  const visible = text.replace(THINKING_TAG_RE, (_match, _tag, inner: string) => {
    blocks.push(inner.trim());
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { visibleText: visible, thinkingBlocks: blocks };
}

/**
 * Detect partial/streaming thinking — text that starts a tag but hasn't closed yet.
 * Used to suppress streaming-display of thinking content until we know what tag it is.
 */
export function hasOpenThinkingTag(text: string): boolean {
  const opens = (text.match(/<(thinking|think|reasoning|reflection)>/gi) || []).length;
  const closes = (text.match(/<\/(thinking|think|reasoning|reflection)>/gi) || []).length;
  return opens > closes;
}

/**
 * If `s` ends with a dangling `<…` that has no closing `>` yet AND could still grow into a
 * suppressible marker (a thinking/tool open tag, or a stray closer), cut it. This is the
 * stateless analog of {@link StreamDisplayFilter}'s tail-buffering: without it, a partial
 * tag like `<thinki` would flash for one frame in the re-rendering UI before the rest of
 * the tag arrives and the block gets stripped. Conservative: a lone trailing `<` is held
 * too (it resolves on the next frame).
 */
function trimTrailingPartialTag(s: string): string {
  const lt = s.lastIndexOf('<');
  if (lt === -1) return s;
  const tail = s.slice(lt);
  if (tail.includes('>')) return s; // complete tag — handled by the block/closer passes
  const lower = tail.toLowerCase();
  const openForms = ['<thinking>', '<think>', '<reasoning>', '<reflection>',
    '<function_call>', '<tool_call>', '<tool_use>', '<tool>'];
  const couldGrow =
    openForms.some(t => t.startsWith(lower)) ||
    '<function='.startsWith(lower) ||
    /^<function=[a-z_][\w.-]*$/i.test(tail) ||
    STRAY_CLOSERS.some(c => c.startsWith(lower));
  return couldGrow ? s.slice(0, lt).trimEnd() : s;
}

/**
 * Strip thinking for display from a FULL accumulated string (not a stream).
 *
 * For consumers like the React UI that re-render the whole accumulated text every frame:
 * remove completed `<thinking>…</thinking>` blocks, drop an in-progress (still open)
 * trailing block, and hold a dangling partial open tag. Stateless — safe to call on each
 * render. For append-only stdout streams use {@link StreamDisplayFilter} instead.
 */
export function stripThinkingForDisplay(text: string): string {
  if (!text) return text;
  // Fast path: no tags to extract, but STILL collapse runaway blank lines and
  // trim. Some local models emit long runs of newlines before their answer;
  // without this they'd render as a huge gap (the old early-return skipped it).
  if (!text.includes('<')) {
    return text.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');
  }
  let s = extractThinking(text).visibleText;
  // An unclosed block mid-stream: cut from the opening tag to the end, dropping the
  // now-dangling whitespace that preceded it.
  const open = s.match(/<(thinking|think|reasoning|reflection)>[\s\S]*$/i);
  if (open && open.index !== undefined) s = s.slice(0, open.index).trimEnd();
  return trimTrailingPartialTag(s);
}

// Tag-delimited spans we suppress from display. Two kinds leak from local models that
// emit tool calls (or reasoning) as plain text instead of via the structured field:
//   - reasoning blocks: <thinking>…</thinking> and variants
//   - tool-call blocks:  <tool_call>…</tool_call>, <function=name>…</function>, etc.
// The agent loop recovers the tool calls and strips them from history regardless; this is
// purely about not flashing the raw syntax at the user mid-stream.
const SUPPRESS_BLOCKS: ReadonlyArray<{ open: string; close: string }> = [
  { open: '<thinking>', close: '</thinking>' },
  { open: '<think>', close: '</think>' },
  { open: '<reasoning>', close: '</reasoning>' },
  { open: '<reflection>', close: '</reflection>' },
  { open: '<tool_call>', close: '</tool_call>' },
  { open: '<function_call>', close: '</function_call>' },
  { open: '<tool_use>', close: '</tool_use>' },
  { open: '<tool>', close: '</tool>' },
];
// Llama/Granite/qwen3-coder style open tag carries the tool name: <function=read_file>.
const FUNCTION_OPEN_RE = /^<function=[a-zA-Z_][\w.-]*>/i;
const FUNCTION_OPEN_PARTIAL_RE = /^<function=[a-zA-Z_][\w.-]*$/i; // name begun, no '>' yet
// Prefixes that a lone '<…' tail could still grow into an opening marker.
const OPEN_PREFIXES = ['<function=', ...SUPPRESS_BLOCKS.map(b => b.open)];
// Closers we swallow even with no matching opener (models leak stray '</tool_call>' etc.).
const STRAY_CLOSERS = ['</function>', ...SUPPRESS_BLOCKS.map(b => b.close)];

/** True if `lower` is a non-empty proper prefix of any candidate (i.e. a split-tag tail). */
function isProperPrefixOfAny(lower: string, candidates: readonly string[]): boolean {
  return lower.length > 0 && candidates.some(c => lower.length < c.length && c.startsWith(lower));
}

/**
 * Streaming filter that strips reasoning blocks AND leaked tool-call syntax from an
 * append-only text stream — for consumers like the headless CLI that print deltas directly
 * to stdout and cannot re-render previously emitted text (unlike the React UI, which
 * re-strips the full accumulated string each frame).
 *
 * Handles markers split across delta boundaries by buffering a tail that could still grow
 * into one. Also trims leading whitespace so suppressing a leading block leaves no blank
 * lines at the top of the answer.
 *
 * Nothing is lost: the agent loop recovers tool calls and emits reasoning as a separate
 * `thinking` event, and `--json` mode surfaces every event verbatim.
 */
export class StreamDisplayFilter {
  private buf = '';
  /** Non-null while inside a suppressed block; holds the close marker we're waiting for. */
  private closeTarget: string | null = null;
  private emittedVisible = false;

  /** Feed one delta; returns the visible text to emit (suppressed spans removed). */
  push(delta: string): string {
    const work = this.buf + delta;
    this.buf = '';
    let out = '';
    let i = 0;
    while (i < work.length) {
      const c = work[i]!;
      if (c !== '<') {
        if (!this.closeTarget) out += this.emit(c);
        i++;
        continue;
      }
      const rest = work.slice(i);
      const lower = rest.toLowerCase();

      if (this.closeTarget) {
        // Inside a suppressed block — only the matching close tag ends it.
        if (lower.startsWith(this.closeTarget)) {
          i += this.closeTarget.length;
          this.closeTarget = null;
          continue;
        }
        if (isProperPrefixOfAny(lower, [this.closeTarget])) { this.buf = rest; return out; }
        i++; // some other '<' inside the block (e.g. <parameter=…>) — keep suppressing
        continue;
      }

      // Visible: try an opening marker, then a stray closer to swallow.
      const open = this.matchOpen(rest, lower);
      if (open === 'partial') { this.buf = rest; return out; }
      if (open) { this.closeTarget = open.close; i += open.len; continue; }

      const stray = this.matchStrayClose(lower);
      if (stray === 'partial') { this.buf = rest; return out; }
      if (stray) { i += stray; continue; } // swallow stray closer, emit nothing

      out += this.emit(c); // literal '<' (e.g. "a < b", "<div>")
      i++;
    }
    return out;
  }

  /** End of stream: a block that never closed is dropped; any other tail is emitted. */
  flush(): string {
    const tail = this.buf;
    this.buf = '';
    if (this.closeTarget) return '';
    let out = '';
    for (const c of tail) out += this.emit(c);
    return out;
  }

  private matchOpen(rest: string, lower: string): { close: string; len: number } | 'partial' | null {
    const fn = rest.match(FUNCTION_OPEN_RE);
    if (fn) return { close: '</function>', len: fn[0].length };
    for (const b of SUPPRESS_BLOCKS) {
      if (lower.startsWith(b.open)) return { close: b.close, len: b.open.length };
    }
    if (FUNCTION_OPEN_PARTIAL_RE.test(rest) || isProperPrefixOfAny(lower, OPEN_PREFIXES)) return 'partial';
    return null;
  }

  private matchStrayClose(lower: string): number | 'partial' | null {
    for (const cl of STRAY_CLOSERS) {
      if (lower.startsWith(cl)) return cl.length;
    }
    return isProperPrefixOfAny(lower, STRAY_CLOSERS) ? 'partial' : null;
  }

  /** Drop leading whitespace so a stripped leading block leaves no blank top lines. */
  private emit(c: string): string {
    if (!this.emittedVisible && /\s/.test(c)) return '';
    this.emittedVisible = true;
    return c;
  }
}

/**
 * Full-string companion to {@link StreamDisplayFilter} for the re-rendering React UI:
 * remove leaked tool-call tag blocks (and stray closers / an unclosed trailing block).
 * Reasoning blocks are handled separately by {@link stripThinkingForDisplay}; JSON-shaped
 * leaks by the UI's own stripLeakedToolJson.
 */
export function stripLeakedToolTags(text: string): string {
  if (!text || !text.includes('<')) return text;
  let s = text
    .replace(/<function=[a-zA-Z_][\w.-]*>[\s\S]*?<\/function>/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function_call>[\s\S]*?<\/function_call>/gi, '')
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, '')
    .replace(/<tool>[\s\S]*?<\/tool>/gi, '')
    .replace(/<\/(?:function|tool_call|function_call|tool_use|tool)>/gi, '');
  // An unclosed block still streaming in: cut from its opening tag to the end.
  const open = s.match(/<(?:function=[a-zA-Z_][\w.-]*|tool_call|function_call|tool_use|tool)>[\s\S]*$/i);
  if (open && open.index !== undefined) s = s.slice(0, open.index).trimEnd();
  return trimTrailingPartialTag(s.replace(/\n{3,}/g, '\n\n'));
}
