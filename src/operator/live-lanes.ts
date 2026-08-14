/**
 * Live lanes — fold tagged hub streams into per-run dock state.
 *
 * The hub is a multiplexed pipe. The TUI must NOT dump [bg1] into the main
 * transcript. This module is the fold: one lane per source, capped lines,
 * unread count while the dock is collapsed. PURE — no Ink, no I/O.
 */

import type { LiveStream } from './hub.js';
import type { SideRun, SideRunStatus } from '../agent/side-runs.js';

export const LANE_LINE_CAP = 6;
export const LANE_VISIBLE_CAP = 4;

export interface LaneLine {
  stream: LiveStream;
  text: string;
}

export interface Lane {
  id: string;
  prompt: string;
  status: SideRunStatus;
  lines: LaneLine[];
  unread: number;
}

export function upsertLane(lanes: Lane[], patch: Partial<Lane> & { id: string }): Lane[] {
  const i = lanes.findIndex(l => l.id === patch.id);
  if (i < 0) {
    return [...lanes, {
      id: patch.id,
      prompt: patch.prompt ?? '',
      status: patch.status ?? 'running',
      lines: patch.lines ?? [],
      unread: patch.unread ?? 0,
    }];
  }
  const next = lanes.slice();
  next[i] = { ...next[i]!, ...patch, id: patch.id };
  return next;
}

export function appendLaneLine(
  lanes: Lane[],
  id: string,
  stream: LiveStream,
  text: string,
  opts: { cap?: number; bumpUnread?: boolean } = {},
): Lane[] {
  const cap = opts.cap ?? LANE_LINE_CAP;
  const trimmed = text.replace(/\s+$/u, '');
  if (!trimmed) return lanes;
  const existing = lanes.find(l => l.id === id);
  const base = existing ?? { id, prompt: '', status: 'running' as const, lines: [], unread: 0 };
  const line: LaneLine = { stream, text: trimmed };
  const updated: Lane = {
    ...base,
    lines: [...base.lines, line].slice(-cap),
    unread: opts.bumpUnread ? base.unread + 1 : base.unread,
  };
  return upsertLane(lanes, updated);
}

export function applyRunToLanes(lanes: Lane[], run: SideRun): Lane[] {
  return upsertLane(lanes, {
    id: run.id,
    prompt: run.prompt,
    status: run.status,
  });
}

export function markLanesRead(lanes: Lane[]): Lane[] {
  if (lanes.every(l => l.unread === 0)) return lanes;
  return lanes.map(l => (l.unread === 0 ? l : { ...l, unread: 0 }));
}

/** Running first (stable order), then most recently updated finished — capped. */
export function visibleLanes(lanes: Lane[], max = LANE_VISIBLE_CAP): Lane[] {
  const running = lanes.filter(l => l.status === 'running');
  const rest = lanes.filter(l => l.status !== 'running');
  return [...running, ...rest].slice(0, max);
}

export function lastLine(lane: Lane): LaneLine | undefined {
  return lane.lines[lane.lines.length - 1];
}
