import { describe, it, expect, vi } from 'vitest';
import { BotGateway } from '../src/bot/gateway.ts';
import { COMMANDS, findCommand, menuDescriptors } from '../src/bot/commands.ts';
import type { Transport, Incoming, MessageRef, Button, AgentRunner } from '../src/bot/types.ts';

/** Fake transport that also captures the native command-menu registration. */
function fakeTransport() {
  let onMsg: (m: Incoming) => void = () => {};
  const sent: Array<{ text: string; buttons?: Button[][] }> = [];
  let menu: { command: string; description: string }[] | null = null;
  const t: Transport = {
    platform: 'telegram', maxLen: 4000, minEditIntervalMs: 0,
    start: async (cb) => { onMsg = cb; },
    stop: async () => {},
    send: async (_c, text, buttons) => { sent.push({ text, buttons }); return { id: 'm' } as MessageRef; },
    edit: async () => {},
    setCommands: async (c) => { menu = c; },
  };
  const inject = (text: string) => onMsg({ platform: 'telegram', chatId: 'c1', userId: 'u1', text } as Incoming);
  return { t, sent, inject, get menu() { return menu; } };
}

const allow = { telegram: { allowedUsers: ['u1'] } };
const flush = () => new Promise(r => setTimeout(r, 0));
const lastText = (sent: { text: string }[]) => sent[sent.length - 1]!.text;

describe('bot command registry', () => {
  it('parses /word args, case-insensitively, with /start aliasing /help', () => {
    expect(findCommand('/status')?.cmd.name).toBe('status');
    expect(findCommand('/MODEL gpt-4o')).toMatchObject({ cmd: { name: 'model' }, args: 'gpt-4o' });
    expect(findCommand('/start')?.cmd.name).toBe('help');
    expect(findCommand('not a command')).toBeNull();
    expect(findCommand('/nope')).toBeNull();
  });

  it('the menu descriptors cover every command (drives setMyCommands)', () => {
    const menu = menuDescriptors();
    expect(menu.map(m => m.command)).toEqual(COMMANDS.map(c => c.name));
    expect(menu.every(m => m.description.length > 0 && m.description.length <= 64)).toBe(true);
  });

  it('registers the native command menu on start', async () => {
    const { t, menu } = fakeTransport();
    const gw = new BotGateway({ transports: [t], agent: { runTurn: async () => '' }, allow });
    await gw.start();
    expect(t.setCommands).toBeDefined();
    // menu captured via the getter
    const fresh = fakeTransport();
    const gw2 = new BotGateway({ transports: [fresh.t], agent: { runTurn: async () => '' }, allow });
    await gw2.start();
    expect(fresh.menu?.map(m => m.command)).toContain('status');
    void menu;
  });

  it('/help lists every command from the registry', async () => {
    const { t, sent, inject } = fakeTransport();
    const gw = new BotGateway({ transports: [t], agent: { runTurn: async () => '' }, allow });
    await gw.start();
    inject('/help'); await flush();
    for (const c of COMMANDS) expect(lastText(sent)).toContain(`/${c.name}`);
  });

  it('/status reports idle + model + cwd from the runner', async () => {
    const { t, sent, inject } = fakeTransport();
    const agent: AgentRunner = {
      runTurn: async () => '',
      status: async () => ({ model: 'qwen3-coder', cwd: '/proj', auto: false }),
    };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject('/status'); await flush();
    expect(lastText(sent)).toContain('qwen3-coder');
    expect(lastText(sent)).toContain('/proj');
  });

  it('/auto on and /model reach the runner; degrade gracefully when unsupported', async () => {
    const setAuto = vi.fn(async () => {});
    const setModel = vi.fn(async (_k: string, m: string) => m);
    const { t, sent, inject } = fakeTransport();
    const agent: AgentRunner = { runTurn: async () => '', setAuto, setModel };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject('/auto on'); await flush();
    expect(setAuto).toHaveBeenCalledWith('telegram:c1', true);
    inject('/model gpt-4o'); await flush();
    expect(setModel).toHaveBeenCalledWith('telegram:c1', 'gpt-4o');
    expect(lastText(sent)).toContain('gpt-4o');

    // a runner without the capability is told, not crashed
    const bare = fakeTransport();
    const gw2 = new BotGateway({ transports: [bare.t], agent: { runTurn: async () => '' }, allow });
    await gw2.start();
    bare.inject('/auto on'); await flush();
    expect(lastText(bare.sent)).toMatch(/isn.t available/i);
  });

  it('/sessions and /resume go through the runner', async () => {
    const resume = vi.fn(async () => true);
    const { t, sent, inject } = fakeTransport();
    const agent: AgentRunner = {
      runTurn: async () => '',
      listSessions: async () => [{ id: 'abcd1234ef', title: 'fix auth', when: '2h ago' }],
      resume,
    };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject('/sessions'); await flush();
    expect(lastText(sent)).toContain('abcd1234');
    expect(lastText(sent)).toContain('fix auth');
    inject('/resume abcd1234'); await flush();
    expect(resume).toHaveBeenCalledWith('telegram:c1', 'abcd1234');
  });

  it('/impact and /rename delegate to the code-graph tools via a turn', async () => {
    const calls: string[] = [];
    const { t, sent, inject } = fakeTransport();
    const agent: AgentRunner = { runTurn: async (_k, txt) => { calls.push(txt); return ''; } };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject('/impact getUser'); await flush(); await flush();
    expect(calls[0]).toContain('analyze_impact');
    expect(calls[0]).toContain('getUser');
    inject('/rename oldFn newFn'); await flush(); await flush();
    expect(calls[1]).toContain('safe_rename');
    expect(calls[1]).toContain('oldFn'); expect(calls[1]).toContain('newFn');
    inject('/impact'); await flush(); // missing arg → usage, no extra turn
    expect(calls).toHaveLength(2);
    expect(lastText(sent)).toMatch(/usage/i);
  });

  it('/episodes lists episodic memory (and degrades when absent)', async () => {
    const { t, sent, inject } = fakeTransport();
    const agent: AgentRunner = { runTurn: async () => '', listEpisodes: async () => [{ when: '2h ago', prompt: 'add pagination to /orders', summary: 'cursor pagination, tests pass' }] };
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject('/episodes'); await flush();
    expect(lastText(sent)).toContain('add pagination');
    expect(lastText(sent)).toContain('2h ago');
    const bare = fakeTransport();
    const gw2 = new BotGateway({ transports: [bare.t], agent: { runTurn: async () => '' }, allow });
    await gw2.start();
    bare.inject('/episodes'); await flush();
    expect(lastText(bare.sent)).toMatch(/isn.t available/i);
  });

  it('an unknown /command is rejected gracefully (not run as a task)', async () => {
    const runTurn = vi.fn(async () => '');
    const { t, sent, inject } = fakeTransport();
    const gw = new BotGateway({ transports: [t], agent: { runTurn }, allow });
    await gw.start();
    inject('/frobnicate'); await flush();
    expect(runTurn).not.toHaveBeenCalled();
    expect(lastText(sent)).toMatch(/unknown command/i);
  });
});
