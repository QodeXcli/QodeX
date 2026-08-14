import { describe, it, expect } from 'vitest';
import {
  appendLaneLine,
  applyRunToLanes,
  markLanesRead,
  visibleLanes,
  lastLine,
} from '../src/operator/live-lanes.js';
import type { SideRun } from '../src/agent/side-runs.js';

function run(partial: Partial<SideRun> & { id: string }): SideRun {
  return {
    prompt: 'do the thing',
    sessionId: `sess/${partial.id}`,
    status: 'running',
    startedAt: 1,
    ...partial,
  };
}

describe('live lanes — bg stays out of the main stream', () => {
  it('opens a lane from a running side run', () => {
    const lanes = applyRunToLanes([], run({ id: 'bg1', prompt: 'write tests' }));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ id: 'bg1', prompt: 'write tests', status: 'running', unread: 0 });
  });

  it('appends capped lines and bumps unread while collapsed', () => {
    let lanes = applyRunToLanes([], run({ id: 'bg1' }));
    for (let i = 0; i < 8; i++) {
      lanes = appendLaneLine(lanes, 'bg1', 'out', `line ${i}`, { bumpUnread: true, cap: 6 });
    }
    expect(lanes[0]!.lines.map(l => l.text)).toEqual([
      'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7',
    ]);
    expect(lanes[0]!.unread).toBe(8);
    expect(lastLine(lanes[0]!)?.text).toBe('line 7');
  });

  it('does not mix sources into one lane', () => {
    let lanes = appendLaneLine([], 'bg1', 'out', 'from bg1', { bumpUnread: true });
    lanes = appendLaneLine(lanes, 'bg2', 'err', 'from bg2', { bumpUnread: true });
    expect(lanes.map(l => l.id)).toEqual(['bg1', 'bg2']);
    expect(lanes[0]!.lines[0]!.stream).toBe('out');
    expect(lanes[1]!.lines[0]!.stream).toBe('err');
  });

  it('drops blank live lines', () => {
    const lanes = appendLaneLine([], 'bg1', 'out', '   ');
    expect(lanes).toEqual([]);
  });

  it('clears unread when the dock is opened', () => {
    let lanes = appendLaneLine([], 'bg1', 'out', 'ok', { bumpUnread: true });
    lanes = markLanesRead(lanes);
    expect(lanes[0]!.unread).toBe(0);
  });

  it('keeps running lanes first and caps the dock', () => {
    let lanes = applyRunToLanes([], run({ id: 'bg1', status: 'done' }));
    lanes = applyRunToLanes(lanes, run({ id: 'bg2', status: 'running' }));
    lanes = applyRunToLanes(lanes, run({ id: 'bg3', status: 'failed' }));
    lanes = applyRunToLanes(lanes, run({ id: 'bg4', status: 'running' }));
    lanes = applyRunToLanes(lanes, run({ id: 'bg5', status: 'cancelled' }));
    const vis = visibleLanes(lanes, 3);
    expect(vis.map(l => l.id)).toEqual(['bg2', 'bg4', 'bg1']);
  });
});
