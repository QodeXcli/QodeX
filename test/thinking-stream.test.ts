import { describe, it, expect } from 'vitest';
import { StreamDisplayFilter, stripThinkingForDisplay, stripLeakedToolTags, extractThinking } from '../src/llm/thinking.js';

/** Feed `chunks` through the filter one at a time and return the concatenated visible output. */
function run(chunks: string[]): string {
  const f = new StreamDisplayFilter();
  let out = '';
  for (const c of chunks) out += f.push(c);
  out += f.flush();
  return out;
}

describe('StreamDisplayFilter (append-only streaming)', () => {
  it('passes plain text through unchanged', () => {
    expect(run(['Hello, ', 'world!'])).toBe('Hello, world!');
  });

  it('strips a whole thinking block delivered in one chunk', () => {
    expect(run(['<thinking>secret reasoning</thinking>The answer is 42.'])).toBe('The answer is 42.');
  });

  it('strips a thinking block when tags are split across deltas', () => {
    // The opening and closing tags are fragmented exactly the way a token stream does it.
    const chunks = ['<thin', 'king>', 'reason', 'ing here', '</think', 'ing>', 'Visible ', 'answer'];
    expect(run(chunks)).toBe('Visible answer');
  });

  it('handles <think>, <reasoning>, <reflection> variants (case-insensitive)', () => {
    expect(run(['<THINK>a</THINK>x'])).toBe('x');
    expect(run(['<reasoning>r</reasoning>y'])).toBe('y');
    expect(run(['<reflection>z</reflection>w'])).toBe('w');
  });

  it('does not eat a literal "<" that is not a thinking tag', () => {
    expect(run(['if a < b && c > d then'])).toBe('if a < b && c > d then');
    expect(run(['render <div>hi</div> done'])).toBe('render <div>hi</div> done');
  });

  it('trims leading whitespace left behind after a leading thinking block', () => {
    expect(run(['<thinking>plan</thinking>\n\nThe file prints Hello.'])).toBe('The file prints Hello.');
  });

  it('suppresses an unclosed thinking block that never closes before flush', () => {
    expect(run(['<thinking>still going when the stream ended'])).toBe('');
  });

  it('keeps visible text before a thinking block', () => {
    expect(run(['Let me check. ', '<thinking>hmm</thinking>', 'Done.'])).toBe('Let me check. Done.');
  });

  it('suppresses a leaked <function=…> tool call (qwen3-coder on Ollama)', () => {
    const leak = '<function=read_file>\n<parameter=path>hello_world.py</parameter>\n</function>';
    expect(run([leak, 'The file prints Hello.'])).toBe('The file prints Hello.');
  });

  it('suppresses a <function=…> block when split across deltas, plus a trailing stray </tool_call>', () => {
    // Mirrors the exact shape qwen3-coder emits, fragmented like a token stream.
    const chunks = [
      '<func', 'tion=read_file>\n', '<parameter=path>', 'hello_world.py', '</parameter>\n',
      '</func', 'tion>\n', '</tool_call>', 'The file prints Hello.',
    ];
    expect(run(chunks)).toBe('The file prints Hello.');
  });

  it('suppresses <tool_call>{…}</tool_call> and swallows a stray closer', () => {
    expect(run(['<tool_call>{"name":"grep"}</tool_call>found 3 matches'])).toBe('found 3 matches');
    expect(run(['answer</tool_call>'])).toBe('answer');
  });

  it('does not mistake <function_call> handling for a literal "<" in prose', () => {
    expect(run(['for x < 10 and y > 2, compute'])).toBe('for x < 10 and y > 2, compute');
  });
});

describe('stripThinkingForDisplay (full-string, for the re-rendering UI)', () => {
  it('removes completed blocks', () => {
    expect(stripThinkingForDisplay('<thinking>x</thinking>answer')).toBe('answer');
  });

  it('hides an in-progress unclosed block mid-stream', () => {
    expect(stripThinkingForDisplay('answer so far <thinking>partial reasoning')).toBe('answer so far');
  });

  it('leaves plain text untouched', () => {
    expect(stripThinkingForDisplay('just text, no tags')).toBe('just text, no tags');
  });

  it('holds a dangling partial open tag so it does not flash for a frame', () => {
    // The frame where only "<thinki" has streamed: must not show until the tag resolves.
    expect(stripThinkingForDisplay('answer <thinki')).toBe('answer');
    expect(stripThinkingForDisplay('answer <')).toBe('answer');
    // Once the block closes, the visible text returns.
    expect(stripThinkingForDisplay('answer <thinking>r</thinking>')).toBe('answer');
  });
});

describe('stripLeakedToolTags (full-string, for the re-rendering UI)', () => {
  it('removes a completed <function=…> block', () => {
    expect(stripLeakedToolTags('<function=read_file><parameter=path>x</parameter></function>answer')).toBe('answer');
  });

  it('removes <tool_call>…</tool_call> and stray closers', () => {
    expect(stripLeakedToolTags('<tool_call>{"name":"grep"}</tool_call>done')).toBe('done');
    expect(stripLeakedToolTags('text</tool_call>')).toBe('text');
  });

  it('cuts an unclosed trailing tool-call block mid-stream', () => {
    expect(stripLeakedToolTags('partial answer <function=read_file><parameter=path>x')).toBe('partial answer');
  });

  it('leaves prose and HTML-ish text untouched', () => {
    expect(stripLeakedToolTags('compare a < b in <code>x</code>')).toBe('compare a < b in <code>x</code>');
  });

  it('holds a dangling partial <function= tag mid-stream', () => {
    expect(stripLeakedToolTags('reading now <function=read_fi')).toBe('reading now');
    expect(stripLeakedToolTags('reading now <function')).toBe('reading now');
  });
});

describe('extractThinking still returns blocks for the separate event', () => {
  it('captures block content while removing it from visible text', () => {
    const ex = extractThinking('<thinking>my reasoning</thinking>visible');
    expect(ex.visibleText).toBe('visible');
    expect(ex.thinkingBlocks).toEqual(['my reasoning']);
  });
});

describe('stripThinkingForDisplay collapses runaway whitespace', () => {
  it('strips a long run of leading newlines when there are no tags', () => {
    // Regression: some local models emit dozens of blank lines before the answer.
    // The old early-return left them, rendering as a huge gap in the stream.
    const noisy = '\n'.repeat(40) + 'The answer is no.';
    expect(stripThinkingForDisplay(noisy)).toBe('The answer is no.');
  });

  it('collapses 3+ internal newlines to a paragraph break', () => {
    expect(stripThinkingForDisplay('Part one\n\n\n\n\nPart two')).toBe('Part one\n\nPart two');
  });

  it('preserves a normal paragraph break (does not over-collapse)', () => {
    expect(stripThinkingForDisplay('Line A\n\nLine B')).toBe('Line A\n\nLine B');
  });

  it('leaves tagless plain text otherwise intact', () => {
    expect(stripThinkingForDisplay('just a sentence')).toBe('just a sentence');
  });
});
