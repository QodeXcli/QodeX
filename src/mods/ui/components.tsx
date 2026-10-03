/**
 * The Ink pieces ui.tsx mounts for mods: the band above the prompt, the pane region,
 * status lines under the prompt, toasts, the spinner suffix and the transcript lines
 * for $.ui.log / $.ui.notice. All of them read a ModsUiSnapshot and draw nothing when
 * no mod has anything to show, so a session without mods looks exactly as before.
 */

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { ModsUiController, type ModsUiContext, type ModsUiSnapshot, type ModHistoryLine } from './controller.js';
import { ModTree, estimateRows } from './render.js';

/** Subscribe a component to the controller's snapshot. */
export function useModsUi(c: ModsUiController): ModsUiSnapshot {
  return useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
}

export interface ModsUiBinding {
  ctl: ModsUiController;
  snap: ModsUiSnapshot;
}

/**
 * Mount the mods UI in a TUI component: one controller for the component's life that
 * follows the registered mods host, kept told of the busy state, terminal size, prompt
 * emptiness and mode. `onHistory` receives $.ui.log / $.ui.notice lines (and refusals).
 */
export function useModsUiController(opts: ModsUiContext & {
  onHistory: (line: ModHistoryLine) => void;
  onPrompt?: (p: { plugin: string; text: string; asUser: boolean }) => void;
}): ModsUiBinding {
  const onHistory = useRef(opts.onHistory);
  onHistory.current = opts.onHistory;
  const onPrompt = useRef(opts.onPrompt);
  onPrompt.current = opts.onPrompt;
  const [ctl] = useState(() => new ModsUiController({
    onHistory: line => onHistory.current(line),
    onPrompt: p => onPrompt.current?.(p),
  }));
  useEffect(() => ctl.start(), [ctl]);
  const { busy, columns, rows, promptEmpty, mode } = opts;
  useEffect(() => {
    ctl.setContext({ busy, columns, rows, promptEmpty, ...(mode ? { mode } : {}) });
  }, [ctl, busy, columns, rows, promptEmpty, mode]);
  return { ctl, snap: useModsUi(ctl) };
}

/**
 * Cap a region at `maxRows` (Ink has no max-height): fixed height + clip only when over.
 * Children of a capped box need flexShrink={0}, or Yoga squeezes them on top of each other.
 */
function cap(estimate: number, maxRows: number): { height?: number; overflowY?: 'hidden' } {
  return estimate > maxRows ? { height: maxRows, overflowY: 'hidden' } : {};
}

/** Toasts: the newest few, right-aligned on the first line of the live area. */
export function ModsToasts(props: { snap: ModsUiSnapshot; width: number }): React.ReactElement | null {
  const { toasts } = props.snap;
  if (toasts.length === 0) return null;
  return (
    <Box flexDirection="column" width={props.width} alignItems="flex-end" paddingX={1}>
      {toasts.map(t => (
        <Text key={t.id} wrap="truncate">
          <Text color="cyan">◆ </Text>
          <Text bold>{t.plugin}</Text>
          <Text>: {t.text}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** The AbovePrompt band: every mod's tree stacked, in load order. */
export function ModsBand(props: { snap: ModsUiSnapshot; width: number; maxRows: number }): React.ReactElement | null {
  const { band, focus, focusedKey } = props.snap;
  if (band.length === 0) return null;
  const focused = focus?.kind === 'band';
  const inner = Math.max(10, props.width - 2);
  const est = band.reduce((n, b) => n + estimateRows(b.tree, inner), 0);
  return (
    <Box flexDirection="column" width={props.width} paddingX={1}>
      <Box flexDirection="column" {...cap(est, props.maxRows)}>
        {band.map(b => (
          <Box key={b.plugin} flexDirection="column" flexShrink={0}>
            <ModTree el={b.tree} ctx={{ width: inner, focusedKey: focused ? focusedKey : null }} />
          </Box>
        ))}
      </Box>
      {focused && <Text dimColor wrap="truncate">mods · Tab/↑↓ move · Enter press · Esc back to the prompt</Text>}
    </Box>
  );
}

/**
 * Panes: a framed region above the prompt. One pane shows its title; several show a tab
 * strip and the active pane's body (Ctrl+X Tab moves the keyboard and the active tab).
 */
export function ModsPanes(props: { snap: ModsUiSnapshot; width: number; maxRows: (pane: { rows?: number }) => number }): React.ReactElement | null {
  const { panes, activePane, focus, focusedKey } = props.snap;
  if (panes.length === 0) return null;
  const active = panes.find(p => p.id === activePane) ?? panes[panes.length - 1]!;
  const focused = focus?.kind === 'pane' && focus.id === active.id;
  const inner = Math.max(10, props.width - 4);
  const limit = props.maxRows(active);
  const est = active.tree ? estimateRows(active.tree, inner) : 1;
  return (
    <Box flexDirection="column" width={props.width} borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1}>
      <Box justifyContent="space-between">
        <Text wrap="truncate">
          {panes.length > 1
            ? panes.map((p, i) => (
              <Text key={p.id}>
                {i > 0 ? '  ' : ''}
                {p.id === active.id ? <Text bold inverse={focused}>{` ${p.title} `}</Text> : <Text dimColor>{p.title}</Text>}
              </Text>
            ))
            : <Text bold>{active.title}</Text>}
        </Text>
        <Text dimColor wrap="truncate">
          {focused ? '  Tab move · Enter press · Esc back · ^X X close' : '  ^X Tab focus'}
        </Text>
      </Box>
      <Box flexDirection="column" {...cap(est, limit)}>
        {active.tree
          ? (
            <Box flexDirection="column" flexShrink={0}>
              <ModTree el={active.tree} ctx={{ width: inner, focusedKey: focused ? focusedKey : null }} />
            </Box>
          )
          : <Text dimColor>…</Text>}
      </Box>
    </Box>
  );
}

/** $.ui.status lines under the prompt, one per mod. */
export function ModsStatusLines(props: { snap: ModsUiSnapshot; width: number }): React.ReactElement | null {
  const { statuses } = props.snap;
  if (statuses.length === 0) return null;
  return (
    <Box flexDirection="column" width={props.width} paddingX={1}>
      {statuses.map(s => (
        <Text key={s.plugin} color="yellow" wrap="truncate">⚠ {s.plugin}: {s.text}</Text>
      ))}
    </Box>
  );
}

/**
 * The spinner line's word with what mods added: a suffix after the word, or a mod's own
 * tree in its place (an `engine` element inside that tree draws QodeX's word).
 */
export function ModsSpinnerWord(props: { spinner: ModsUiSnapshot['spinner']; word: string; width: number }): React.ReactElement {
  const own = <Text dimColor>{props.word}{props.spinner?.suffix ?? '…'}</Text>;
  if (props.spinner?.tree) {
    return <ModTree el={props.spinner.tree} ctx={{ width: props.width, engine: own }} />;
  }
  return own;
}

/** A transcript line from $.ui.log ("● mod: …", dim), $.ui.notice ("💡 mod: …") or a mod error (red). */
export function ModHistoryLineView(props: { line: ModHistoryLine }): React.ReactElement {
  const { kind, plugin, text } = props.line;
  if (kind === 'error') return <Text color="red" dimColor>● {plugin}: {text}</Text>;
  if (kind === 'notice') {
    return (
      <Text>
        <Text color="yellow">💡 </Text>
        <Text color="yellow" bold>{plugin}</Text>
        <Text color="yellow">: {text}</Text>
      </Text>
    );
  }
  return <Text dimColor>● {plugin}: {text}</Text>;
}
