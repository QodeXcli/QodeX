import { describe, it, expect } from 'vitest';
import {
  wordLeft, wordRight, deleteWordLeft, insertAt, backspace,
  deleteRange, replaceRange,
  isPasteBurst, countLines, pasteLabel,
  removeAttachmentAt, renumberImageLabels,
  type Attachment,
} from '../src/cli/components/editor-logic.js';

describe('editor-logic word navigation', () => {
  it('jumps left over a word', () => {
    expect(wordLeft('foo bar', 7)).toBe(4);
    expect(wordLeft('foo bar', 4)).toBe(0);
  });
  it('jumps right over a word', () => {
    expect(wordRight('foo bar', 0)).toBe(3);
    expect(wordRight('foo bar', 3)).toBe(7);
  });
  it('skips leading whitespace when jumping left', () => {
    expect(wordLeft('   hi', 5)).toBe(3);
  });
  it('clamps out-of-range cursors', () => {
    expect(wordLeft('abc', 99)).toBe(0);
    expect(wordRight('abc', -5)).toBe(3);
  });
});

describe('editor-logic edits', () => {
  it('deletes the word left of the cursor', () => {
    expect(deleteWordLeft('foo bar', 7)).toEqual({ text: 'foo ', cursor: 4 });
  });
  it('inserts at the cursor', () => {
    expect(insertAt('ac', 1, 'b')).toEqual({ text: 'abc', cursor: 2 });
  });
  it('backspaces, and is a no-op at start', () => {
    expect(backspace('abc', 2)).toEqual({ text: 'ac', cursor: 1 });
    expect(backspace('abc', 0)).toEqual({ text: 'abc', cursor: 0 });
  });
  it('deletes a selected range (order-independent, clamped)', () => {
    expect(deleteRange('hello world', 5, 11)).toEqual({ text: 'hello', cursor: 5 });
    expect(deleteRange('hello world', 11, 5)).toEqual({ text: 'hello', cursor: 5 });
    expect(deleteRange('abc', 0, 99)).toEqual({ text: '', cursor: 0 });
  });
  it('replaces a selected range (select-all replace)', () => {
    expect(replaceRange('hello world', 0, 5, 'hi')).toEqual({ text: 'hi world', cursor: 2 });
    expect(replaceRange('abc', 0, 3, 'X')).toEqual({ text: 'X', cursor: 1 });
  });
});

describe('editor-logic paste classification', () => {
  it('does not treat a single keystroke as a paste', () => {
    expect(isPasteBurst('a')).toBe(false);
    expect(isPasteBurst('hi')).toBe(false);
  });
  it('treats a multi-line or sizeable burst as a paste', () => {
    expect(isPasteBurst('a\nb')).toBe(true);
    expect(isPasteBurst('x'.repeat(20))).toBe(true);
  });
  it('counts lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\nc')).toBe(3);
  });
  it('labels a paste with line count and size', () => {
    expect(pasteLabel('a\nb\nc')).toContain('3 lines');
    expect(pasteLabel('hello')).toContain('1 line');
  });
});

describe('editor-logic attachment chips', () => {
  it('removes the chip at an index and leaves the rest', () => {
    const atts: Attachment[] = [
      { kind: 'paste', label: 'Pasted 1 line (35 B)', payload: 'x' },
      { kind: 'image', label: 'Image #1', payload: '/a.png' },
    ];
    const afterLast = removeAttachmentAt(atts, atts.length - 1); // Backspace pops last
    expect(afterLast).toHaveLength(1);
    expect(afterLast[0]!.kind).toBe('paste');
    expect(removeAttachmentAt(afterLast, 0)).toHaveLength(0);
  });

  it('renumbers image chips after one is removed', () => {
    const imgs: Attachment[] = [
      { kind: 'image', label: 'Image #1', payload: 'a' },
      { kind: 'image', label: 'Image #2', payload: 'b' },
      { kind: 'image', label: 'Image #3', payload: 'c' },
    ];
    const out = removeAttachmentAt(imgs, 0); // drop the first
    expect(out.map(a => a.label)).toEqual(['Image #1', 'Image #2']);
  });

  it('leaves paste-chip labels alone while renumbering images', () => {
    const mixed: Attachment[] = [
      { kind: 'image', label: 'Image #1', payload: 'a' },
      { kind: 'paste', label: 'Pasted 5 lines (1.0 KB)', payload: 'p' },
      { kind: 'image', label: 'Image #2', payload: 'b' },
    ];
    const out = renumberImageLabels(mixed);
    expect(out.map(a => a.label)).toEqual(['Image #1', 'Pasted 5 lines (1.0 KB)', 'Image #2']);
  });

  it('returns the list unchanged for an out-of-range index', () => {
    const atts: Attachment[] = [{ kind: 'paste', label: 'p', payload: 'x' }];
    expect(removeAttachmentAt(atts, 5)).toEqual(atts);
    expect(removeAttachmentAt(atts, -1)).toEqual(atts);
  });
});
