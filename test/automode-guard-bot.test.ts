/**
 * The chat bot under auto mode:
 *   - `/auto on` puts THAT conversation in the autonomous policy (a per-chat engine) — the
 *     process and the other chats keep their mode;
 *   - the bot's askUser NEVER answers by itself: Sentinel-critical prompts, auto mode's
 *     remaining asks and everything else become buttons for the person;
 *   - `/mission` from an auto conversation starts an auto mission.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QodexAgentRunner, botAskUser } from '../src/bot/runner.js';
import { BotGateway } from '../src/bot/gateway.js';
import type { Transport, Incoming, MessageRef, Button, AgentRunner } from '../src/bot/types.js';
import { Sentinel, isSentinelPrompt } from '../src/sentinel/guard.js';
import { isAutoModeAskPrompt, isAutonomousContext } from '../src/sentinel/auto-mode.js';
import { autonomousDecision, workspaceRoots } from '../src/security/autonomy.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { ApprovalBroker } from '../src/control/approvals.js';
import { PermissionEngine, getApprovalMode, setApprovalMode } from '../src/security/permissions.js';
import { botLane, getOperatorHub } from '../src/operator/hub.js';
import { MissionStore, setMissionStoreForTests } from '../src/missions/store.js';
import { setMissionWorkerSpawner, setMissionsDirForTests } from '../src/missions/daemon.js';
import type { ToolContext } from '../src/tools/base.js';

let tmp: string;
const KEY = `telegram:auto-${process.pid}`;
const OTHER = `telegram:manual-${process.pid}`;

function runner(config = DEFAULT_CONFIG) {
  const permissions = new PermissionEngine({ ...config, security: { ...config.security, denyRules: ['rm -rf /'] } });
  return {
    permissions,
    r: new QodexAgentRunner({ config, router: {} as any, registry: {} as any, permissions, cwd: tmp }),
  };
}

const flushHub = () => new Promise(r => setTimeout(r, 5));

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-automode-bot-'));
  setApprovalMode('manual');
});
afterEach(async () => {
  setApprovalMode('manual');
  getOperatorHub().cancelLane(botLane(KEY));
  getOperatorHub().cancelLane(botLane(OTHER));
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('/auto is a per-conversation auto mode', () => {
  it('only the conversation that turned it on runs the autonomous policy', async () => {
    const { r, permissions } = runner();
    await r.setAuto(KEY, true);
    expect(r.isAuto(KEY)).toBe(true);
    expect(r.isAuto(OTHER)).toBe(false);
    expect(getApprovalMode()).toBe('manual');
    const autoEngine = r.permissionsFor(KEY, tmp);
    expect(autoEngine).not.toBe(permissions);
    expect(isAutonomousContext({ permissions: autoEngine })).toBe(true);
    expect(r.permissionsFor(OTHER, tmp)).toBe(permissions);
    expect(isAutonomousContext({ permissions })).toBe(false);
    await r.setAuto(KEY, false);
    expect(r.permissionsFor(KEY, tmp)).toBe(permissions);
  });

  it("the per-chat engine keeps base's deny rules and read-only allows, and asks autonomousDecision for the rest", async () => {
    const { r } = runner();
    await r.setAuto(KEY, true);
    const e = r.permissionsFor(KEY, tmp);
    expect(e.evaluate({ tool: 'shell', operation: 'rm -rf /' })).toBe('deny');
    expect(e.evaluate({ tool: 'read_file', operation: 'src/a.ts' })).toBe('allow');
    for (const op of ['npm install lodash', 'git commit -am wip', 'rm -rf ~/elsewhere']) {
      const expected = autonomousDecision({ tool: 'shell', operation: op }, { cwd: tmp, roots: workspaceRoots(tmp) }).decision;
      expect(e.evaluate({ tool: 'shell', operation: op }), op).toBe(expected);
    }
  });

  it('a process already in auto mode shows every chat as auto', async () => {
    const { r } = runner();
    setApprovalMode('auto');
    expect(r.isAuto(OTHER)).toBe(true);
    expect((await r.status(OTHER)).auto).toBe(true);
  });
});

describe('the bot never auto-answers', () => {
  it('a Sentinel-critical prompt in an auto conversation waits for the person (buttons)', async () => {
    const { r } = runner();
    await r.setAuto(KEY, true);
    const sentinel = new Sentinel({
      config: () => ({ ...DEFAULT_SENTINEL_CONFIG, audit: false }),
      audit: null,
      broker: () => new ApprovalBroker(),
      interactive: () => true, // startBots marks the bot process as having a human
      browser: () => null,
    });
    const ctx = {
      cwd: tmp, sessionId: 's', transaction: {} as any,
      permissions: r.permissionsFor(KEY, tmp), askUser: botAskUser(KEY), emit: () => {},
    } as unknown as ToolContext;

    // ordinary desktop input: silent in auto mode, nothing reaches the chat
    expect(await sentinel.beforeTool('computer_use_click', { x: 1, y: 1 }, ctx)).toBeNull();
    expect(getOperatorHub().pending(botLane(KEY))).toBeNull();

    // a purchase: shown in the chat, not answered by anyone but the person
    const buy = sentinel.beforeTool('mcp:shop:purchase_item', { item: 'tv' }, ctx);
    await flushHub();
    const p = getOperatorHub().pending(botLane(KEY))!;
    expect(p).not.toBeNull();
    expect(isSentinelPrompt(p.prompt)).toBe(true);
    expect(isAutoModeAskPrompt(p.prompt)).toBe(true);
    expect(p.options).toEqual(['yes', 'no']);
    await flushHub();
    expect(getOperatorHub().pending(botLane(KEY))?.id).toBe(p.id); // still waiting
    getOperatorHub().answer(p.id, 'no');
    expect((await buy)?.content).toMatch(/^\[SENTINEL_DENIED\]/);

    // a remote delete: auto mode still asks — in the chat
    const del = sentinel.beforeTool('mcp:gdrive:delete_file', { id: 'x' }, ctx);
    await flushHub();
    const d = getOperatorHub().pending(botLane(KEY))!;
    expect(d.prompt).toContain('Auto mode still asks');
    getOperatorHub().answer(d.id, 'yes');
    expect(await del).toBeNull();
  });

  it('every prompt (even a plain yes/no) goes to the chat in auto mode', async () => {
    const ask = botAskUser(KEY);
    const answer = ask('Run: rm -rf ~/old-project', ['yes', 'no', 'always yes']);
    await flushHub();
    const p = getOperatorHub().pending(botLane(KEY))!;
    expect(p.prompt).toBe('Run: rm -rf ~/old-project');
    getOperatorHub().answer(p.id, 'no');
    expect(await answer).toBe('no');
  });
});

describe('bot commands', () => {
  function fakeTransport() {
    let onMsg: (m: Incoming) => void = () => {};
    const sent: Array<{ text: string; buttons?: Button[][] }> = [];
    const t: Transport = {
      platform: 'telegram', maxLen: 4000, minEditIntervalMs: 0,
      start: async (cb) => { onMsg = cb; },
      stop: async () => {},
      send: async (_c, text, buttons) => { sent.push({ text, buttons }); return { id: 'm' } as MessageRef; },
      edit: async () => {},
    };
    const inject = (text: string) => onMsg({ platform: 'telegram', chatId: 'c1', userId: 'u1', text } as Incoming);
    return { t, sent, inject };
  }
  const allow = { telegram: { allowedUsers: ['u1'] } };
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('/auto on explains what still asks; /status shows the mode', async () => {
    let auto = false;
    const agent: AgentRunner = {
      runTurn: async () => '',
      setAuto: async (_k, on) => { auto = on; },
      status: async () => ({ model: 'm', cwd: '/p', auto }),
    };
    const { t, sent, inject } = fakeTransport();
    const gw = new BotGateway({ transports: [t], agent, allow });
    await gw.start();
    inject('/auto on'); await flush();
    expect(auto).toBe(true);
    expect(sent[sent.length - 1]!.text).toMatch(/Auto mode ON[\s\S]*purchases, payments, passwords, sending messages/);
    inject('/status'); await flush();
    expect(sent[sent.length - 1]!.text).toMatch(/approval: auto/);
    inject('/auto off'); await flush();
    expect(auto).toBe(false);
    expect(sent[sent.length - 1]!.text).toMatch(/Auto mode OFF/);
  });

  it('/mission from an auto conversation starts an auto mission; from a manual one it asks', async () => {
    const store = new MissionStore(path.join(tmp, 'sessions.db'));
    setMissionStoreForTests(store);
    setMissionsDirForTests(path.join(tmp, 'missions'));
    setMissionWorkerSpawner(() => ({ pid: process.pid, unref: () => {}, on: () => undefined }) as any);
    try {
      let auto = true;
      const agent: AgentRunner = { runTurn: async () => '', status: async () => ({ model: 'm', cwd: tmp, auto }) };
      const { t, sent, inject } = fakeTransport();
      const gw = new BotGateway({ transports: [t], agent, allow });
      await gw.start();
      inject('/mission tidy the docs'); await new Promise(r => setTimeout(r, 30));
      expect(sent[sent.length - 1]!.text).toMatch(/It runs in auto mode/);
      expect(store.list({ limit: 1 })[0]!.approval_mode).toBe('auto');
      auto = false;
      inject('/mission and again'); await new Promise(r => setTimeout(r, 30));
      expect(store.list({ limit: 1 })[0]!.approval_mode).toBe('ask');
    } finally {
      setMissionStoreForTests(null);
      setMissionsDirForTests(null);
      setMissionWorkerSpawner(null);
    }
  });
});
