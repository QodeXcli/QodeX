import React, { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { findImagePaths, findFsPaths, splitPathsAndText } from '../../utils/image-paths.js';
import {
  wordLeft, wordRight, deleteWordLeft, insertAt, backspace,
  deleteRange, replaceRange,
  isPasteBurst, pasteLabel, removeAttachmentAt,
  type Attachment,
} from './editor-logic.js';

interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  /** Called with typed text + attachment payloads joined, when the user hits Enter. */
  onSubmit: (fullText: string) => void;
  cwd: string;
  placeholder?: string;
  accentColor?: string;
  motion?: boolean;
  /** Leading marker (❯ / spinner) supplied by the parent so busy-state shows through. */
  prefix?: React.ReactNode;
  /** When false (e.g. a permission menu is open) the editor ignores keystrokes. */
  active?: boolean;
  /** True while a turn is running — Esc then means "abort" (parent), not "clear". */
  busy?: boolean;
  /** Shared list of previously submitted prompts for ↑/↓ recall. */
  historyRef: React.MutableRefObject<string[]>;
}

/**
 * A small single-purpose line/￼multiline editor for the prompt box.
 *
 * Replaces ink-text-input to get: word-jump (Alt+←/→), Home/End (Ctrl+A/E),
 * delete-word (Ctrl+W), clear-to-start (Ctrl+U), multiline (Shift/Alt+Enter),
 * ↑/↓ history recall, and paste/image handling — a pasted blob or image path
 * becomes a compact chip instead of dumping raw text (and newlines) into the line.
 *
 * Parent still owns Ctrl+C / Esc (interrupt / exit / clear); this editor ignores
 * them so there's no double-handling.
 */
export function ChatInput(props: ChatInputProps): React.ReactElement {
  const {
    value, onChange, onSubmit, cwd, placeholder,
    accentColor = 'cyan', prefix, active = true, busy = false, historyRef,
  } = props;
  const [cursor, setCursor] = useState(value.length);
  const [anchor, setAnchor] = useState<number | null>(null); // selection start, or null
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const histIdx = useRef<number | null>(null);
  const draft = useRef('');

  // Keep the cursor in range if `value` is changed from the outside (Esc clears,
  // history recall sets a new string, type-ahead resets to '').
  useEffect(() => {
    setCursor(c => Math.max(0, Math.min(c, value.length)));
    setAnchor(null);
  }, [value]);

  const apply = (t: string, c: number) => {
    onChange(t);
    setCursor(Math.max(0, Math.min(c, t.length)));
    setAnchor(null);       // any edit collapses the selection
    histIdx.current = null; // and drops out of history-recall mode
  };

  // Selection = the half-open range [min(anchor,cursor), max(anchor,cursor)).
  const hasSelection = anchor !== null && anchor !== cursor;
  const selFrom = anchor === null ? cursor : Math.min(anchor, cursor);
  const selTo = anchor === null ? cursor : Math.max(anchor, cursor);

  const clearAll = () => {
    onChange('');
    setCursor(0);
    setAnchor(null);
    setAttachments([]);
    histIdx.current = null;
  };

  const submit = () => {
    const parts: string[] = [];
    if (value.trim()) parts.push(value);
    for (const a of attachments) parts.push(a.payload);
    const full = parts.join('\n').trim();
    if (!full) return;
    onSubmit(full);
    onChange('');
    setCursor(0);
    setAnchor(null);
    setAttachments([]);
    histIdx.current = null;
  };

  useInput((input, key) => {
    if (!active) return;
    if (key.ctrl && input === 'c') return; // parent: interrupt / exit

    // Esc: while busy, let the parent abort the run. While idle, clear the
    // typed text AND any paste/image chips (this is what "Esc removes the
    // pasted blob / image" means).
    if (key.escape) {
      if (busy) return;
      if (value || attachments.length > 0) { clearAll(); return; }
      return;
    }

    // Enter submits; Shift/Alt+Enter inserts a newline (multiline compose).
    if (key.return) {
      if (key.shift || key.meta) {
        const r = hasSelection ? replaceRange(value, selFrom, selTo, '\n') : insertAt(value, cursor, '\n');
        apply(r.text, r.cursor); return;
      }
      submit();
      return;
    }

    // History recall (↑/↓).
    if (key.upArrow) {
      const h = historyRef.current;
      if (h.length === 0) return;
      if (histIdx.current === null) draft.current = value;
      const next = histIdx.current === null ? h.length - 1 : Math.max(0, histIdx.current - 1);
      histIdx.current = next;
      onChange(h[next]); setCursor(h[next].length); setAnchor(null);
      return;
    }
    if (key.downArrow) {
      if (histIdx.current === null) return;
      const h = historyRef.current;
      const next = histIdx.current + 1;
      if (next >= h.length) { histIdx.current = null; onChange(draft.current); setCursor(draft.current.length); }
      else { histIdx.current = next; onChange(h[next]); setCursor(h[next].length); }
      setAnchor(null);
      return;
    }

    // Cursor movement. Shift extends a selection; a plain arrow collapses it.
    // Alt jumps by word.
    if (key.leftArrow) {
      const dest = key.meta ? wordLeft(value, cursor) : Math.max(0, cursor - 1);
      if (key.shift) { setAnchor(a => (a === null ? cursor : a)); setCursor(dest); }
      else if (hasSelection) { setCursor(selFrom); setAnchor(null); }
      else setCursor(dest);
      return;
    }
    if (key.rightArrow) {
      const dest = key.meta ? wordRight(value, cursor) : Math.min(value.length, cursor + 1);
      if (key.shift) { setAnchor(a => (a === null ? cursor : a)); setCursor(dest); }
      else if (hasSelection) { setCursor(selTo); setAnchor(null); }
      else setCursor(dest);
      return;
    }

    // Ctrl+A = SELECT ALL (then Backspace or typing replaces everything).
    if (key.ctrl && input === 'a') {
      if (value.length === 0) return;
      setAnchor(0); setCursor(value.length);
      return;
    }
    if (key.ctrl && input === 'e') { setAnchor(null); setCursor(value.length); return; } // End
    if (key.ctrl && input === 'w') {
      if (hasSelection) { const r = deleteRange(value, selFrom, selTo); apply(r.text, r.cursor); return; }
      const r = deleteWordLeft(value, cursor); apply(r.text, r.cursor); return;
    }
    if (key.ctrl && input === 'u') { apply(value.slice(hasSelection ? selFrom : cursor), 0); return; }

    // Backspace (some terminals send delete): remove the selection if any, else one char.
    // When the text line is empty, Backspace instead pops the LAST chip — so attachments
    // can be removed one at a time (newest first), like a chat/token input.
    if (key.backspace || key.delete) {
      if (hasSelection) { const r = deleteRange(value, selFrom, selTo); apply(r.text, r.cursor); return; }
      if (value.length === 0 && attachments.length > 0) {
        setAttachments(prev => removeAttachmentAt(prev, prev.length - 1));
        return;
      }
      const r = backspace(value, cursor); apply(r.text, r.cursor); return;
    }

    // Printable single char, or a paste burst (multi-char in one event).
    if (input && !key.ctrl && !key.meta) {
      if (isPasteBurst(input)) {
        const imgs = findImagePaths(input, cwd);
        if (imgs.length > 0 && input.trim().length > 0 && findFsPaths(input, cwd).every(p => p.kind === 'file')) {
          setAttachments(prev => {
            const base = prev.filter(a => a.kind === 'image').length;
            const next: Attachment[] = imgs.map((p, i) => ({ kind: 'image', label: `Image #${base + i + 1}`, payload: p }));
            return [...prev, ...next];
          });
          return;
        }
        // A dragged-in folder or non-image file: make it a clearly-labeled chip with a
        // framed payload, so the agent treats it as the target — not a vague pasted blob.
        // Crucially, keep any instruction text that came in the SAME burst (drag-drop often
        // pastes the path next to what the user typed) — otherwise the agent gets a folder
        // with no task and flails.
        const { paths: allPaths, text: remainder } = splitPathsAndText(input, cwd);
        const fsPaths = allPaths.filter(p => !imgs.includes(p.abs));
        if (fsPaths.length > 0) {
          setAttachments(prev => [...prev, ...fsPaths.map(p => ({
            kind: p.kind,
            label: p.name,
            payload: p.kind === 'dir'
              ? `[Attached directory: ${p.abs}] — treat this folder as the project/codebase to work on.`
              : `[Attached file: ${p.abs}]`,
          }))]);
          if (remainder) {
            const r = insertAt(value, cursor, remainder);
            apply(r.text, r.cursor);
          }
          return;
        }
        // Otherwise it's just a large text paste.
        setAttachments(prev => [...prev, { kind: 'paste', label: pasteLabel(input), payload: input }]);
        return;
      }
      // Typing over a selection replaces it.
      const r = hasSelection ? replaceRange(value, selFrom, selTo, input) : insertAt(value, cursor, input);
      apply(r.text, r.cursor);
    }
  });

  const showPlaceholder = !value && attachments.length === 0;
  // When there's a selection, render it as one inverse span. Otherwise render an
  // inverse-video cursor block (a cursor on a newline / past the end shows as a space).
  let body: React.ReactNode;
  if (showPlaceholder) {
    body = <Text dimColor>{placeholder}</Text>;
  } else if (hasSelection) {
    body = <Text>{value.slice(0, selFrom)}<Text inverse>{value.slice(selFrom, selTo)}</Text>{value.slice(selTo)}</Text>;
  } else {
    const atRaw = value.slice(cursor, cursor + 1);
    const atChar = atRaw === '' || atRaw === '\n' ? ' ' : atRaw;
    const before = value.slice(0, cursor);
    const after = atRaw === '\n' ? '\n' + value.slice(cursor + 1) : value.slice(cursor + 1);
    body = <Text>{before}<Text inverse>{atChar}</Text>{after}</Text>;
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {attachments.length > 0 && (
        <Box flexWrap="wrap">
          {attachments.map((a, i) => {
            const isLast = i === attachments.length - 1;
            const icon = a.kind === 'image' ? '🖼  ' : a.kind === 'dir' ? '📁  ' : a.kind === 'file' ? '📄  ' : '📋  ';
            const color = a.kind === 'image' ? 'magenta' : a.kind === 'paste' ? 'yellow' : 'green';
            return (
              <Text key={i} color={color} bold={isLast}>
                {icon}[{a.label}]{isLast ? ' ✕' : ''}
                {i < attachments.length - 1 ? '   ' : ''}
              </Text>
            );
          })}
          <Text dimColor>   (⌫ removes last · Esc clears all)</Text>
        </Box>
      )}
      <Box>
        {prefix}
        <Text> </Text>
        {body}
      </Box>
    </Box>
  );
}
