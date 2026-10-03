/**
 * Cross-module follow-ups for the agent-platform channels: the mission event
 * bridge (one bus event per status transition), Telegram pairing registering the
 * approval channel before it says "Paired!", the Telegram mission adapter not
 * forwarding the control center's token, /control's mission-action refcount,
 * the workflow CLI's permission engine, `workflow record --browser-profile`, and
 * root flags written after a subcommand reaching that subcommand (real CLI).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MissionStore, setMissionStoreForTests } from '../src/missions/store.js';
import { startMissionEventBridge } from '../src/missions/index.js';
import { runMission, missionAskUser, type AgentLike } from '../src/missions/runner.js';
import { MissionMilestoneTool } from '../src/missions/tools.js';
import { createTelegramMissionAdapter } from '../src/missions/telegram-adapter.js';
import { getBus, type BusEvent } from '../src/control/bus.js';
import { ApprovalBroker } from '../src/control/approvals.js';
import { listControlActions, stopControlCenter } from '../src/control/server.js';
import { TelegramApi, type FetchLike, type TgUpdate } from '../src/channels/telegram/api.js';
import { TelegramPairingStore } from '../src/channels/telegram/pairing.js';
import { TelegramBot } from '../src/channels/telegram/bot.js';
import { handlePlatformSlash } from '../src/cli/platform-slash.js';
import { buildWorkflowCommand, makeCliContext } from '../src/workflows/command.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { QodexMcpServer } from '../src/mcp/server/server.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Tool, type ToolContext, type ToolResult } from '../src/tools/base.js';
import { z } from 'zod';

const DEAD_PID = 2 ** 22 + 777;

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

let dir: string;
let store: MissionStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-followup-ch-'));
  store = new MissionStore(path.join(dir, 'sessions.db'));
  setMissionStoreForTests(store);
  getBus().reset();
});

afterEach(async () => {
  await stopControlCenter();
  setMissionStoreForTests(null);
  getBus().reset();
  try { (store as any).close?.(); } catch { /* ignore */ }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('mission event bridge', () => {
  it('publishes ONE bus event per status transition, in the in-process runner\'s shape', async () => {
    const m = store.create({ goal: 'bridged once', cwd: dir });
    store.update(m.id, { pid: DEAD_PID }); // "another process" runs it
    const seen: BusEvent[] = [];
    getBus().subscribe(e => seen.push(e));
    const stop = startMissionEventBridge({ store, intervalMs: 100 });
    try {
      store.setStatus(m.id, 'completed');
      store.appendEvent(m.id, 'milestone', { title: 'after-completion' }); // marks the bridge caught up
      await waitFor(() => seen.some(e => e.kind === 'mission' && e.type === 'milestone'));
      const rows = seen.filter(e => e.kind === 'mission' && e.missionId === m.id && e.type !== 'milestone');
      // A timeline (control-center Activity, notifiers) renders every event: one transition, one row.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'status', data: { to: 'completed', status: 'completed' } });
    } finally {
      stop();
    }
  });

  it('a mission run in THIS process reaches the bus once per event, also after it released the mission', async () => {
    const m = store.create({ goal: 'inline once', cwd: dir });
    const seen: BusEvent[] = [];
    getBus().subscribe(e => seen.push(e));
    const stop = startMissionEventBridge({ store, intervalMs: 50 });
    try {
      const agent = (): AgentLike => ({
        buildInitialMessages: async (p) => [{ role: 'user', content: p }],
        pushSteer: () => {},
        run: async function* () {
          // The agent reports a milestone through the tool (it writes AND publishes).
          const tool = new MissionMilestoneTool();
          const res = await tool.execute(tool.argsSchema.parse({ title: 'halfway' }));
          expect(res.isError).toBeFalsy();
          await new Promise(r => setTimeout(r, 150)); // let the bridge tick while the step runs
          yield { type: 'final', data: { content: 'done' } };
        },
      });
      const r = await runMission(m.id, {
        store,
        createAgent: agent,
        complete: async (prompt) => prompt.includes('PLANNER')
          ? JSON.stringify({ steps: [{ id: 's1', title: 'one', instruction: 'do it', depends_on: [] }], success_criteria: 'ok' })
          : 'FINAL REPORT',
        askUserFactory: (stepId, signal) => missionAskUser(m.id, stepId, { signal }),
        sessions: { createSession: () => 'sess-1', recordTurn: () => {}, markStatus: () => {}, addWorklogEntry: () => {} },
        notify: async () => {},
        pollIntervalMs: 20,
        abortGraceMs: 1000,
        config: { maxConcurrency: 1, maxAttempts: 1, stepMaxIterations: 5, stepMaxWallSeconds: 0, maxCostUsd: 0, notify: false },
      });
      expect(r.status).toBe('completed');
      // A foreign row after the run: once the bridge publishes it, it has read every row of the run.
      store.appendEvent(m.id, 'milestone', { title: 'probe' });
      await waitFor(() => seen.some(e => e.kind === 'mission' && (e.data as any)?.title === 'probe'));
      const of = (pred: (e: any) => boolean) => seen.filter(e => e.kind === 'mission' && e.missionId === m.id && pred(e));
      expect(of(e => e.type === 'status' && e.data?.to === 'completed')).toHaveLength(1);
      expect(of(e => e.type === 'completed')).toHaveLength(0);
      expect(of(e => e.type === 'report')).toHaveLength(1);
      expect(of(e => e.type === 'plan')).toHaveLength(1);
      expect(of(e => e.type === 'milestone' && e.data?.title === 'halfway')).toHaveLength(1);
      // The one completion row carries what a timeline / notifier shows.
      expect(of(e => e.type === 'status' && e.data?.to === 'completed')[0]).toMatchObject({ data: { status: 'completed', report: 'FINAL REPORT', stepsDone: 1 } });
    } finally {
      stop();
    }
  });
});

// ── Telegram ─────────────────────────────────────────────────────────────────

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const OWNER = 1001;

/** Just enough Bot API for pairing: getMe, long-polled getUpdates, sendMessage. */
class MiniTelegram {
  sent: Array<{ chatId: number; text: string; channels: string[] }> = [];
  private queue: TgUpdate[] = [];
  private waiters: Array<() => void> = [];
  private nextId = 1;
  constructor(private readonly broker: ApprovalBroker) {}

  fetch: FetchLike = async (url, init = {}) => {
    const method = url.split('/').pop()!;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    switch (method) {
      case 'getMe': return ok({ id: 999, is_bot: true, first_name: 'QodeX', username: 'qx_test_bot' });
      case 'getUpdates': {
        if (body.timeout === 0) return ok([]);
        if (!this.queue.length) {
          await new Promise<void>((resolve, reject) => {
            const signal = init.signal ?? undefined;
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal?.aborted) return onAbort();
            signal?.addEventListener('abort', onAbort, { once: true });
            this.waiters.push(() => { signal?.removeEventListener('abort', onAbort); resolve(); });
          });
        }
        return ok(this.queue.splice(0));
      }
      case 'sendMessage':
        // What a remote approval raised right now would see: the broker's channels.
        this.sent.push({ chatId: Number(body.chat_id), text: String(body.text ?? ''), channels: this.broker.channelNames() });
        return ok({ message_id: 500 + this.sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id), type: 'private' }, text: body.text });
      default:
        return ok(true);
    }
  };

  text(chatId: number, text: string): void {
    this.queue.push({
      update_id: this.nextId++,
      message: {
        message_id: 100 + this.nextId, date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'Alice', username: 'alice', language_code: 'en' }, text,
      },
    } as TgUpdate);
    for (const w of this.waiters.splice(0)) w();
  }
}

describe('telegram pairing', () => {
  it('registers the approval channel BEFORE replying "Paired!"', async () => {
    const broker = new ApprovalBroker();
    const tg = new MiniTelegram(broker);
    const pairing = new TelegramPairingStore({ file: path.join(dir, 'telegram.json') });
    // A long tick so only the pairing path itself can register the channel.
    const bot = new TelegramBot({ api: new TelegramApi({ token: TOKEN, fetch: tg.fetch }), pairing, broker, tickMs: 60_000, sleep: async () => {}, log: () => {} });
    await bot.start();
    try {
      const { code } = await pairing.createPairingCode();
      tg.text(OWNER, `/pair ${code}`);
      await waitFor(() => tg.sent.some(s => s.chatId === OWNER));
      const paired = tg.sent.find(s => s.chatId === OWNER)!;
      expect(paired.text).toContain('Paired!');
      expect(paired.channels).toEqual(['telegram']);
    } finally {
      await bot.stop();
      broker.reset();
    }
  });

  it('the mission adapter never hands the control-center token to Telegram', async () => {
    const m = store.create({ goal: 'watch prices', cwd: dir });
    store.update(m.id, { live_url: 'http://127.0.0.1:7420/?k=SECRET-approval-token' });
    const ad = createTelegramMissionAdapter({ store, defaultCwd: dir });
    const listed = (await ad.list()).find(s => s.id === m.id)!;
    const status = (await ad.status(m.id))!;
    for (const s of [listed, status]) {
      expect(s.liveUrl).toBeTruthy();
      expect(s.liveUrl).not.toContain('SECRET');
    }
  });
});

// ── /control ─────────────────────────────────────────────────────────────────

describe('/control mission actions', () => {
  it('registers once however often /control runs, and /control stop releases them', async () => {
    await handlePlatformSlash('control', [], dir);
    await handlePlatformSlash('control', [], dir);
    expect(listControlActions()).toContain('missions.list');
    await handlePlatformSlash('control', ['stop'], dir);
    expect(listControlActions()).not.toContain('missions.list');
    // ...and a later /control registers them again.
    await handlePlatformSlash('control', [], dir);
    expect(listControlActions()).toContain('missions.list');
    await handlePlatformSlash('control', ['stop'], dir);
    expect(listControlActions()).not.toContain('missions.list');
  }, 20_000);
});

// ── workflows CLI ────────────────────────────────────────────────────────────

describe('qodex workflow', () => {
  it('replays with a permission engine that knows the registry\'s read-only tools', async () => {
    const ctx = await makeCliContext(structuredClone(DEFAULT_CONFIG));
    try {
      // pdf_read is read-only in the registry but not in the engine's fallback list.
      expect(ctx.permissions.evaluateDetailed({ tool: 'pdf_read', operation: 'report.pdf' }).via).toBe('read-only');
    } finally {
      await ctx.cleanup();
    }
  });

  it('the MCP server\'s tool calls (and qodex_sandbox_run) get an engine that knows the registry\'s read-only tools', async () => {
    const verdicts: string[] = [];
    // A plugin-style read-only tool (not in the engine's fallback list), and a stand-in code_run.
    class Probe extends Tool<Record<string, unknown>> {
      description = 'probe';
      argsSchema = z.object({}).passthrough();
      isDestructive = false;
      constructor(public name: string, public isReadOnly: boolean) { super(); }
      async execute(_a: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        verdicts.push(`${this.name}:${ctx.permissions.evaluate({ tool: 'my_plugin_reader', operation: 'x' })}`);
        return { content: 'ok' };
      }
    }
    const registry = new ToolRegistry();
    registry.register(new Probe('my_plugin_reader', true));
    registry.register(new Probe('code_run', false));
    const server = new QodexMcpServer({ registry, config: structuredClone(DEFAULT_CONFIG), cwd: dir, exposeTools: ['my_plugin_reader'] });
    const call = (name: string, args: unknown) => server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } as any);
    await call('my_plugin_reader', {});
    await call('qodex_sandbox_run', { command: 'echo hi' });
    expect(verdicts).toEqual(['my_plugin_reader:allow', 'code_run:allow']);
  });

  it('record takes --browser-profile (the root program owns --profile)', () => {
    const record = buildWorkflowCommand().commands.find(c => c.name() === 'record')!;
    const longs = record.options.map(o => o.long);
    expect(longs).toContain('--browser-profile');
    expect(longs).not.toContain('--profile');
  });
});
