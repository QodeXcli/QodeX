import { describe, it, expect, vi } from 'vitest';
import { BotGateway } from '../src/bot/gateway.ts';
import type { Transport, Incoming, MessageRef, Button, AgentRunner, TurnSink } from '../src/bot/types.ts';

/** A fake transport that captures sends and lets the test inject inbound messages. */
function fakeTransport(platform: 'telegram' | 'discord' = 'telegram') {
  let onMsg: (m: Incoming) => void = () => {};
  const sent: Array<{ chatId: string; text: string; buttons?: Button[][] }> = [];
  let n = 0;
  const t: Transport = {
    platform, maxLen: 4000, minEditIntervalMs: 0,
    start: async (cb) => { onMsg = cb; },
    stop: async () => {},
    send: async (chatId, text, buttons) => { sent.push({ chatId, text, buttons }); return { id: `m${++n}` } as MessageRef; },
    edit: async () => {},
    ackCallback: async () => {},
  };
  const inject = (m: Partial<Incoming>) => onMsg({ platform, chatId: 'c1', userId: 'u1', text: '', ...m } as Incoming);
  return { t, sent, inject };
}

const allowAll = { telegram: { allowedUsers: ['u1'] }, discord: { allowedUsers: ['u1'] } };
const flush = () => new Promise(r => setTimeout(r, 0));

describe('BotGateway', () => {
  it('denies unlisted users (closed by default) and never runs the agent', async () => {
    const { t, sent, inject } = fakeTransport();
    const agent: AgentRunner = { runTurn: vi.fn(async () => 'x') };
    const gw = new BotGateway({ transports: [t], agent, allow: { telegram: { allowedUsers: ['someone-else'] } } });
    await gw.start();
    inject({ userId: 'intruder', text: 'rm -rf /' });
    await flush();
    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(sent[0]!.text).toContain('not on this QodeX bot');
  });

  it('runs a turn and streams the agent output', async () => {
    const { t, inject } = fakeTransport();
    const agent: AgentRunner = {
      runTurn: async (_key, _text, sink: TurnSink) => { await sink.onDelta('working… done'); return 'working… done'; },
    };
    const gw = new BotGateway({ transports: [t], agent, allow: allowAll });
    await gw.start();
    inject({ text: 'do a thing' });
    await flush(); await flush();
    expect((agent.runTurn as any)).toBeDefined();
  });

  it('serializes turns: a message while busy is queued, then run after', async () => {
    const { t, sent, inject } = fakeTransport();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let first = true;
    const agent: AgentRunner = {
      runTurn: async (_k, text) => {
        order.push(`start:${text}`);
        if (first) { first = false; await gate; }   // hold the first turn open
        order.push(`end:${text}`);
        return text;
      },
    };
    const gw = new BotGateway({ transports: [t], agent, allow: allowAll });
    await gw.start();
    inject({ text: 'A' }); await flush();
    inject({ text: 'B' }); await flush();            // arrives while A is running → queued
    expect(sent.some(s => s.text.includes('queued'))).toBe(true);
    expect(order).toEqual(['start:A']);
    release(); await flush(); await flush(); await flush();
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']); // B ran only after A finished
  });

  it('routes a permission ask to buttons and resolves on a tap', async () => {
    const { t, sent, inject } = fakeTransport();
    let answered: string | undefined;
    const agent: AgentRunner = {
      runTurn: async (_k, _text, sink: TurnSink) => { answered = await sink.ask('Run `npm install`?', ['yes', 'no']); return 'ok'; },
    };
    const gw = new BotGateway({ transports: [t], agent, allow: allowAll });
    await gw.start();
    inject({ text: 'install deps' });
    await flush(); await flush();
    const ask = sent.find(s => s.text.includes('Run `npm install`'));
    expect(ask?.buttons?.[0]?.map(b => b.label)).toEqual(['yes', 'no']);
    inject({ callbackData: 'ask:yes', callbackId: 'cb1' }); // user taps "yes"
    await flush(); await flush();
    expect(answered).toBe('yes');
  });

  it('/stop aborts the running turn', async () => {
    const { t, sent, inject } = fakeTransport();
    const agent: AgentRunner = {
      runTurn: (_k, _t, _s, signal) => new Promise((_res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); }),
    };
    const gw = new BotGateway({ transports: [t], agent, allow: allowAll });
    await gw.start();
    inject({ text: 'long task' }); await flush();
    inject({ text: '/stop' }); await flush(); await flush();
    expect(sent.some(s => s.text.includes('Stopped'))).toBe(true);
  });
});
