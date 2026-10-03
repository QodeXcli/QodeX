import { describe, it, expect, vi } from 'vitest';
import { BotGateway } from '../src/bot/gateway.ts';
import type { Transport, Incoming, MessageRef, Button, AgentRunner, TurnSink, ArtifactCard } from '../src/bot/types.ts';

function fakeTransport(withPhoto = true) {
  let onMsg: (m: Incoming) => void = () => {};
  const sent: Array<{ text: string; buttons?: Button[][] }> = [];
  const photos: Array<{ path: string; caption?: string; buttons?: Button[][] }> = [];
  const t: Transport = {
    platform: 'telegram', maxLen: 4000, minEditIntervalMs: 0,
    start: async (cb) => { onMsg = cb; }, stop: async () => {},
    send: async (_c, text, buttons) => { sent.push({ text, buttons }); return { id: 'm' } as MessageRef; },
    edit: async () => {},
    ackCallback: async () => {},
    ...(withPhoto ? { sendPhoto: async (_c: string, path: string, caption?: string, buttons?: Button[][]) => { photos.push({ path, caption, buttons }); return { id: 'p' } as MessageRef; } } : {}),
  };
  const inject = (m: Partial<Incoming>) => onMsg({ platform: 'telegram', chatId: 'c1', userId: 'u1', text: '', ...m } as Incoming);
  return { t, sent, photos, inject };
}

const allow = { telegram: { allowedUsers: ['u1'] } };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); };
const labels = (b?: Button[][]) => b?.[0]?.map(x => x.label) ?? [];
const card: ArtifactCard = { artifactId: 'dash', title: 'Sales Dashboard', type: 'html', verdict: 'looks_good', issues: [], liveUrl: 'http://localhost:7777/', screenshotPath: '/tmp/shot.png' };

describe('living-artifact bot card', () => {
  it('renders the screenshot + verdict + Approve/Edit/Reject after the turn', async () => {
    const { t, photos, inject } = fakeTransport(true);
    const agent: AgentRunner = { runTurn: async (_k, _txt, sink: TurnSink) => { await sink.artifact!(card); return 'done'; } };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject({ text: 'build a sales dashboard with a chart and a table' });
    await flush();
    expect(photos).toHaveLength(1);
    expect(photos[0]!.path).toBe('/tmp/shot.png');
    expect(photos[0]!.caption).toContain('Looks good');
    expect(photos[0]!.caption).toContain('localhost:7777');
    expect(labels(photos[0]!.buttons)).toEqual(['✅ Approve', '✏️ Edit', '🗑 Reject']);
  });

  it('shows the issues when the verdict is needs_work', async () => {
    const { t, photos, inject } = fakeTransport(true);
    const nw: ArtifactCard = { ...card, verdict: 'needs_work', issues: ['table is cut off', 'low contrast'] };
    const agent: AgentRunner = { runTurn: async (_k, _t, s: TurnSink) => { await s.artifact!(nw); return ''; } };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject({ text: 'dashboard' }); await flush();
    expect(photos[0]!.caption).toContain('Needs work');
    expect(photos[0]!.caption).toContain('table is cut off');
  });

  it('falls back to a text card when the adapter cannot send a photo', async () => {
    const { t, sent, inject } = fakeTransport(false); // no sendPhoto
    const agent: AgentRunner = { runTurn: async (_k, _t, s: TurnSink) => { await s.artifact!(card); return ''; } };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject({ text: 'dashboard' }); await flush();
    const cardMsg = sent.find(s => s.text.includes('Looks good'));
    expect(cardMsg).toBeTruthy();
    expect(labels(cardMsg!.buttons)).toEqual(['✅ Approve', '✏️ Edit', '🗑 Reject']);
  });

  it('Approve / Reject taps are acknowledged', async () => {
    const { t, sent, inject } = fakeTransport(true);
    const agent: AgentRunner = { runTurn: async (_k, _t, s: TurnSink) => { await s.artifact!(card); return ''; } };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject({ text: 'dashboard' }); await flush();
    inject({ callbackData: 'art:approve:dash', callbackId: 'cb1' }); await flush();
    expect(sent.some(s => /approved/i.test(s.text))).toBe(true);
    inject({ callbackData: 'art:reject:dash', callbackId: 'cb2' }); await flush();
    expect(sent.some(s => /rejected/i.test(s.text))).toBe(true);
  });

  it('Edit tap captures the next message as a live update turn', async () => {
    const { t, sent, inject } = fakeTransport(true);
    const calls: string[] = [];
    const agent: AgentRunner = {
      runTurn: async (_k, txt, s: TurnSink) => { calls.push(txt); if (calls.length === 1) await s.artifact!(card); return ''; },
    };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject({ text: 'build a dashboard' }); await flush();
    inject({ callbackData: 'art:edit:dash', callbackId: 'cb1' }); await flush();
    expect(sent.some(s => /what should i change/i.test(s.text))).toBe(true);
    inject({ text: 'make it dark mode' }); await flush();
    // the follow-up ran as an UPDATE turn targeting the artifact, carrying the user's tweak
    expect(calls[1]).toContain('dash');
    expect(calls[1]).toContain('make it dark mode');
  });
});
