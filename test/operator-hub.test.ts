import { describe, it, expect, beforeEach } from 'vitest';
import { OperatorHub, botLane, resetOperatorHub } from '../src/operator/hub.js';

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
    expect(hub.pending()?.lane).toBe('tui');
    expect(hub.pending()?.origin).toBe('tui');

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

  it('keeps bot and tui lanes inflight at the same time', async () => {
    const seen: string[] = [];
    hub.subscribe(ev => { if (ev.kind === 'approval') seen.push(`${ev.source}@${ev.origin}`); });

    const local = hub.requestApproval('bg1', 'edit local.ts?', ['yes', 'no']);
    const remote = hub.requestApproval('bot', 'edit remote.ts?', ['yes', 'no'], {
      lane: botLane('telegram:9'),
      origin: 'telegram:9',
    });

    expect(seen).toEqual(['bg1@tui', 'bot@telegram:9']);
    expect(hub.pending('tui')?.source).toBe('bg1');
    expect(hub.pending(botLane('telegram:9'))?.origin).toBe('telegram:9');
    expect(hub.pendingAll()).toHaveLength(2);

    // Answering the remote ask must not stall [bg1].
    hub.answer(hub.pending(botLane('telegram:9'))!.id, 'yes');
    expect(await remote).toBe('yes');
    expect(hub.pending('tui')?.source).toBe('bg1');

    hub.answer(hub.pending('tui')!.id, 'no');
    expect(await local).toBe('no');
    expect(hub.pendingAll()).toHaveLength(0);
  });

  it('cancelLane resolves every waiter on that lane only', async () => {
    const a = hub.requestApproval('main', 'a?', ['yes', 'no']);
    const b = hub.requestApproval('bg1', 'b?', ['yes', 'no']);
    const remote = hub.requestApproval('bot', 'c?', ['yes', 'no'], {
      lane: botLane('telegram:1'),
      origin: 'telegram:1',
    });

    expect(hub.cancelLane('tui', 'no')).toBe(2);
    expect(await a).toBe('no');
    expect(await b).toBe('no');
    expect(hub.pending('tui')).toBeNull();
    expect(hub.pending(botLane('telegram:1'))?.source).toBe('bot');

    hub.answer(hub.pending(botLane('telegram:1'))!.id, 'yes');
    expect(await remote).toBe('yes');
  });

  it('replays every inflight lane to a late subscriber', () => {
    void hub.requestApproval('main', 'tui?', ['yes']);
    void hub.requestApproval('bot', 'bot?', ['yes'], {
      lane: botLane('discord:x'),
      origin: 'discord:x',
    });
    const seen: string[] = [];
    hub.subscribe(ev => { if (ev.kind === 'approval') seen.push(ev.origin); });
    expect(seen.sort()).toEqual(['discord:x', 'tui']);
  });
});
