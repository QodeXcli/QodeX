/**
 * Pure helpers for the ChatInput editor — no React, no Ink, fully unit-testable.
 *
 * The editor itself (cursor rendering, key wiring) can't run in a headless
 * sandbox, so all the fiddly index math lives here where it CAN be tested.
 */

const isWS = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n';

/** Index after jumping one word LEFT from `cursor` (skip whitespace, then word). */
export function wordLeft(text: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, text.length));
  while (i > 0 && isWS(text[i - 1]!)) i--;
  while (i > 0 && !isWS(text[i - 1]!)) i--;
  return i;
}

/** Index after jumping one word RIGHT from `cursor` (skip whitespace, then word). */
export function wordRight(text: string, cursor: number): number {
  const n = text.length;
  let i = Math.max(0, Math.min(cursor, n));
  while (i < n && isWS(text[i]!)) i++;
  while (i < n && !isWS(text[i]!)) i++;
  return i;
}

/** Delete the word immediately left of the cursor (Ctrl+W). Returns new text+cursor. */
export function deleteWordLeft(text: string, cursor: number): { text: string; cursor: number } {
  const start = wordLeft(text, cursor);
  return { text: text.slice(0, start) + text.slice(cursor), cursor: start };
}

/** Insert `s` at `cursor`. Returns new text and the cursor after the inserted text. */
export function insertAt(text: string, cursor: number, s: string): { text: string; cursor: number } {
  const c = Math.max(0, Math.min(cursor, text.length));
  return { text: text.slice(0, c) + s + text.slice(c), cursor: c + s.length };
}

/** Backspace one char left of cursor. */
export function backspace(text: string, cursor: number): { text: string; cursor: number } {
  if (cursor <= 0) return { text, cursor: 0 };
  return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
}

/** Delete the half-open range [from,to) (order-independent). Returns text + cursor at range start. */
export function deleteRange(text: string, from: number, to: number): { text: string; cursor: number } {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(text.length, Math.max(from, to));
  return { text: text.slice(0, a) + text.slice(b), cursor: a };
}

/** Replace the range [from,to) with `s`. Returns text + cursor after the inserted text. */
export function replaceRange(text: string, from: number, to: number, s: string): { text: string; cursor: number } {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(text.length, Math.max(from, to));
  return { text: text.slice(0, a) + s + text.slice(b), cursor: a + s.length };
}

/**
 * Ink delivers a terminal paste as a single multi-character burst in ONE useInput
 * call (one keypress is a single char). So a burst that is multi-char AND either
 * spans lines or is sizeable is treated as a paste — to be shown as a compact chip
 * instead of dumping raw text (and newlines) into the line editor.
 */
export function isPasteBurst(input: string): boolean {
  if (input.length <= 1) return false;
  return input.includes('\n') || input.length >= 12;
}

export function countLines(s: string): number {
  if (s === '') return 0;
  return s.split('\n').length;
}

/** Short, human label for a pasted blob, e.g. "Pasted 42 lines (1.2 KB)". */
export function pasteLabel(s: string): string {
  const lines = countLines(s);
  const bytes = Buffer.byteLength(s, 'utf8');
  const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  const lineStr = lines === 1 ? '1 line' : `${lines} lines`;
  return `Pasted ${lineStr} (${size})`;
}

// ── Attachment chips (pasted blobs / images / dropped files & folders) ──────────
export interface Attachment { kind: 'paste' | 'image' | 'dir' | 'file'; label: string; payload: string; }

/**
 * Re-label image chips so they stay "Image #1, #2, …" in order after one is removed.
 * Other chip kinds keep their own labels (a byte/line count or a file/dir name). Pure.
 */
export function renumberImageLabels(atts: Attachment[]): Attachment[] {
  let n = 0;
  return atts.map(a => (a.kind === 'image' ? { ...a, label: `Image #${++n}` } : a));
}

/**
 * Remove the chip at `index` and renumber the remaining images. Out-of-range index
 * returns the list unchanged. Pure — used by the Backspace-removes-last-chip flow so
 * the user can delete attachments one by one (newest first) like a token input.
 */
export function removeAttachmentAt(atts: Attachment[], index: number): Attachment[] {
  if (index < 0 || index >= atts.length) return atts;
  return renumberImageLabels(atts.filter((_, i) => i !== index));
}
