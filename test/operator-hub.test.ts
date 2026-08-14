import { describe, it, expect, beforeEach } from 'vitest';
import { OperatorHub, resetOperatorHub } from '../src/operator/hub.js';

describe('OperatorHub — one approval queue for every surface', () => {
  let hub: OperatorHub;
  beforeEach(() => { hub = resetOperatorHub(); });

  it('delivers the first ask immediately and parks the second', async () => {
    const seen: string[] = [];
    hub.subscribe(ev => { if (ev.kind === 'approval') seen.push(ev.source); });

    const a = hub.requestApproval('main', 'edit a.ts?', ['yes', 'no']);
    const b = hub.requestApproval('bg1', 'edit b.ts?', ['yes', 'no']);

    expect(seen).toEqual(['main']);
    expect(hub.pending()?.source).toBe('main');

    hub.answer(hub.pending()!.id, 'yes');
    expect(await a).toBe('yes');
    expect(seen).toEqual(['main', 'bg1']);
    expect(hub.pending()?.source).toBe('bg1');

    hub.answer(hub.pending()!.id, 'no');
    expect(await b).toBe('no');
    expect(hub.pending()).toBeNull();
  });

  it('rejects an answer for a stale id', () => {
    void hub.requestApproval('main', 'x', ['yes']);
    expect(hub.answer('nope', 'yes')).toBe(false);
    expect(hub.pending()?.source).toBe('main');
  });

  it('replays the inflight approval to a late subscriber', () => {
    void hub.requestApproval('bg2', 'run npm test?', ['yes', 'no']);
    const seen: string[] = [];
    hub.subscribe(ev => { if (ev.kind === 'approval') seen.push(ev.source); });
    expect(seen).toEqual(['bg2']);
  });

  it('drops blank live lines', () => {
    const lines: string[] = [];
    hub.subscribe(ev => { if (ev.kind === 'live') lines.push(ev.line); });
    hub.emitLive('main', 'out', '  ');
    hub.emitLive('bg1', 'out', 'ok\n');
    expect(lines).toEqual(['ok']);
  });
});
