/**
 * Agent-loop guards vs. browser/desktop observation tools, per-tool timeouts and gate
 * exemptions — pure helpers plus end-to-end runs of a real AgentLoop with a scripted
 * provider (see core-fakes.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Message } from '../src/session/store.js';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-core-guard-home-'));
const ORIG_HOME = process.env.HOME;

let F: typeof import('./core-fakes.js');
let L: typeof import('../src/agent/loop.js');
let S: typeof import('../src/session/store.js');
let Rec: typeof import('../src/agent/recovery.js');
let store: import('../src/session/store.js').SessionStore;
let cwd: string;

beforeAll(async () => {
  process.env.HOME = HOME;
  F = await import('./core-fakes.js');
  L = await import('../src/agent/loop.js');
  S = await import('../src/session/store.js');
  Rec = await import('../src/agent/recovery.js');
  store = new S.SessionStore(path.join(HOME, 'sessions-guard.db'));
  S.setSessionStoreForTests(store);
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-core-guard-cwd-'));
});

afterAll(() => {
  S?.setSessionStoreForTests(null);
  if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
  fs.rmSync(HOME, { recursive: true, force: true });
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
});

async function runAgent(opts: {
  script: (req: any, i: number) => import('./core-fakes.js').FakeTurn;
  tools: InstanceType<typeof import('./core-fakes.js').FakeTool>[];
  prompt?: string;
  mode?: 'normal' | 'subagent';
  config?: any;
  setup?: (agent: any) => void;
}) {
  const provider = new F.FakeProvider(opts.script);
  const agent: any = new L.AgentLoop({
    router: F.fakeRouter(provider),
    registry: new F.FakeRegistry(opts.tools) as any,
    permissions: F.allowAllPermissions,
    config: opts.config ?? F.testConfig(),
    cwd,
  });
  opts.setup?.(agent);
  const sid = store.createSession(cwd, 'fake');
  const events: any[] = [];
  for await (const ev of agent.run(
    [{ role: 'system', content: 'sys' }, { role: 'user', content: opts.prompt ?? 'check the page' }],
    sid,
    { mode: { mode: opts.mode ?? 'subagent' }, askUser: async () => 'no', maxIterationsOverride: 30 },
  )) events.push(ev);
  return { provider, events, sid };
}

/** Every assistant tool_call must be answered by a tool message before the next non-tool message. */
function assertToolPairing(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const want = new Set(m.tool_calls.map(tc => tc.id));
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') { want.delete(messages[j]!.tool_call_id!); j++; }
    expect([...want], `unanswered tool calls after message ${i}`).toEqual([]);
  }
}

const allText = (req: any) => (req?.messages ?? []).map((m: any) => String(m.content ?? '')).join('\n');

describe('pure helpers', () => {
  it('resolveToolTimeoutSeconds: tool override, 0 = none, never less than global', () => {
    expect(Rec.resolveToolTimeoutSeconds(300, undefined)).toBe(300);
    expect(Rec.resolveToolTimeoutSeconds(300, 0)).toBe(0);
    expect(Rec.resolveToolTimeoutSeconds(300, 600)).toBe(600);
    expect(Rec.resolveToolTimeoutSeconds(300, 60)).toBe(300);
    expect(Rec.resolveToolTimeoutSeconds(undefined, undefined)).toBe(300);
    expect(Rec.resolveToolTimeoutSeconds(0, 600)).toBe(0);
    expect(Rec.resolveToolTimeoutSeconds(300, -1)).toBe(300);
    expect(Rec.resolveToolTimeoutSeconds(300, Number.NaN)).toBe(300);
  });

  it('isGateExemptTool covers artifact_ + the agent-computer families only', () => {
    for (const n of ['artifact_create', 'browser_click', 'computer_use_type', 'workflow_run', 'mission_start', 'vault_list']) {
      expect(Rec.isGateExemptTool(n)).toBe(true);
    }
    for (const n of ['write_file', 'edit_text', 'shell', 'task', 'git_commit', 'dev_server_start']) {
      expect(Rec.isGateExemptTool(n)).toBe(false);
    }
  });

  it('isStateDependentTool / resultHash', () => {
    expect(Rec.isStateDependentTool('browser_snapshot')).toBe(true);
    expect(Rec.isStateDependentTool('computer_use_screenshot')).toBe(true);
    expect(Rec.isStateDependentTool('read_file')).toBe(false);
    expect(Rec.resultHash('a')).toBe(Rec.resultHash('a'));
    expect(Rec.resultHash('a')).not.toBe(Rec.resultHash('b'));
    expect(Rec.resultHash('a')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('detectStuckLoop with result-hashed keys: changing results are progress, identical ones are stuck', () => {
    const c = (name: string, h: string) => ({ name, argsHash: `args:${h}` });
    expect(Rec.detectStuckLoop([c('browser_snapshot', '1'), c('browser_snapshot', '2'), c('browser_snapshot', '3')])).toBe(false);
    expect(Rec.detectStuckLoop([c('browser_snapshot', '1'), c('browser_snapshot', '1'), c('browser_snapshot', '1')])).toBe(true);
    expect(Rec.detectStuckLoop([c('browser_scroll', 's'), c('browser_snapshot', '1'), c('browser_scroll', 's'), c('browser_snapshot', '2')])).toBe(false);
    expect(Rec.detectStuckLoop([c('browser_scroll', 's'), c('browser_snapshot', '1'), c('browser_scroll', 's'), c('browser_snapshot', '1')])).toBe(true);
  });

  it('guard messages are tailored for observation tools', () => {
    expect(Rec.readLoopAbortMessage('read_file', 5, 32768)).toContain('context');
    expect(Rec.readLoopAbortMessage('browser_status', 5, 32768)).toContain("page/screen isn't changing");
    expect(Rec.readLoopSummarizeMessage('browser_status', 3)).toContain('page/screen is not changing');
    expect(Rec.readLoopSummarizeMessage('read_file', 3)).toContain('re-read the same file');
    expect(Rec.stuckLoopMessage('browser_snapshot')).toContain('SAME result');
    expect(Rec.stuckLoopMessage('read_file')).toContain('re-reading files');
  });
});

describe('loop guards with browser/desktop observation tools (end-to-end)', () => {
  it('repeated identical snapshots whose results CHANGE are not treated as stuck', async () => {
    let page = 0;
    const snap = new F.FakeTool('browser_snapshot', () => ({ content: `Page: Long article\n- paragraph ${++page}` }));
    const { provider, events } = await runAgent({
      tools: [snap],
      script: (_r, i) => (i < 6 ? { calls: [{ name: 'browser_snapshot', args: {} }] } : { text: 'Read the whole article.' }),
    });
    expect(snap.calls.length).toBe(6);
    expect(events.find(e => e.type === 'final')?.data?.content).toBe('Read the whole article.');
    expect(provider.requests.some(r => allText(r).includes("You've called"))).toBe(false);
    expect(provider.requests.some(r => allText(r).includes('LOOP_GUARD'))).toBe(false);
  });

  it('scroll → snapshot cycles through a long page are progress (results change)', async () => {
    let y = 0;
    const scroll = new F.FakeTool('browser_scroll', () => ({ content: '✓ scrolled down' }));
    const snap = new F.FakeTool('browser_snapshot', () => ({ content: `Page: Feed\n- item ${y++}` }));
    const { provider } = await runAgent({
      tools: [scroll, snap],
      script: (_r, i) => (i < 5
        ? { calls: [{ name: 'browser_scroll', args: { direction: 'down' } }, { name: 'browser_snapshot', args: {} }] }
        : { text: 'done' }),
    });
    expect(snap.calls.length).toBe(5);
    expect(provider.requests.some(r => allText(r).includes("You've called"))).toBe(false);
  });

  it('identical call + identical result repeats ARE flagged (after they ran), with observation-specific advice', async () => {
    const snap = new F.FakeTool('browser_snapshot', () => ({ content: 'Page: Stuck\n- spinner' }));
    const { provider } = await runAgent({
      tools: [snap],
      script: (_r, i) => (i < 3 ? { calls: [{ name: 'browser_snapshot', args: {} }] } : { text: 'blocked by a spinner' }),
    });
    expect(snap.calls.length).toBe(3); // nothing skipped — the 3rd result is what proves it's stuck
    const req4 = provider.requests[3]!;
    expect(allText(req4)).toContain("You've called `browser_snapshot`");
    expect(allText(req4)).toContain('SAME result');
    assertToolPairing(req4.messages);
  });

  it('the same scroll+snapshot cycle with UNCHANGED results is flagged', async () => {
    const scroll = new F.FakeTool('browser_scroll', () => ({ content: '✓ scrolled (already at bottom)' }));
    const snap = new F.FakeTool('browser_snapshot', () => ({ content: 'Page: Feed\n- footer' }));
    const { provider } = await runAgent({
      tools: [scroll, snap],
      script: (_r, i) => (i < 4
        ? { calls: [{ name: 'browser_scroll', args: { direction: 'down' } }, { name: 'browser_snapshot', args: {} }] }
        : { text: 'done' }),
    });
    const flaggedAt = provider.requests.findIndex(r => allText(r).includes("You've called"));
    expect(flaggedAt).toBe(2); // after the 2nd identical cycle
  });

  it('a read-only observation returning the same thing 3× forces a text-only summary', async () => {
    const status = new F.FakeTool('browser_status', () => ({ content: 'running, 1 tab' }), { readOnly: true });
    const { provider } = await runAgent({
      tools: [status],
      script: (_r, i) => (i < 3 ? { calls: [{ name: 'browser_status', args: {} }] } : { text: 'summary' }),
    });
    const req4 = provider.requests[3]!;
    expect(req4.tools ?? []).toEqual([]);
    expect(allText(req4)).toContain('page/screen is not changing');
    assertToolPairing(req4.messages);
  });

  it('page text saying "not found" does not count as a soft failure (no error-loop nudge)', async () => {
    let n = 0;
    const text = new F.FakeTool('browser_get_text', () => ({ content: `404 Not Found (page ${n++})` }));
    const { provider } = await runAgent({
      tools: [text],
      script: (_r, i) => (i < 4 ? { calls: [{ name: 'browser_get_text', args: { selector: `#s${i}` } }] } : { text: 'done' }),
    });
    expect(provider.requests.some(r => allText(r).includes('times with different arguments'))).toBe(false);
  });

  it('non-observation tools keep the old behavior: the 3rd identical call is skipped, every tool_call still gets a result', async () => {
    const probe = new F.FakeTool('probe', () => ({ content: 'same' }));
    const { provider } = await runAgent({
      tools: [probe],
      script: (_r, i) => (i < 3 ? { calls: [{ name: 'probe', args: { q: 1 } }] } : { text: 'stopped' }),
    });
    expect(probe.calls.length).toBe(2); // 3rd identical call never executed
    const req4 = provider.requests[3]!;
    expect(F.toolResultsIn(req4, 'probe').some(c => c.startsWith('[LOOP_GUARD]'))).toBe(true);
    expect(allText(req4)).toContain("You've called `probe`");
    assertToolPairing(req4.messages);
  });

  it('read-only file re-reads still summarize (and the skipped call is answered)', async () => {
    const rf = new F.FakeTool('read_file', () => ({ content: 'file body' }), { readOnly: true });
    const { provider } = await runAgent({
      tools: [rf],
      script: (_r, i) => (i < 3 ? { calls: [{ name: 'read_file', args: { path: 'a.ts' } }] } : { text: 'bugs: none' }),
    });
    const req4 = provider.requests[3]!;
    expect(req4.tools ?? []).toEqual([]);
    expect(allText(req4)).toContain('re-read the same file 3 times');
    assertToolPairing(req4.messages);
  });
});

describe('per-tool timeout (end-to-end)', () => {
  const cfg = () => F.testConfig({ budget: { ...F.testConfig().budget, toolTimeoutSeconds: 1 } });
  const slow = (name: string, timeoutSeconds?: number) =>
    new F.FakeTool(name, async () => { await new Promise(r => setTimeout(r, 1300)); return { content: `${name} finished` }; }, { timeoutSeconds });

  it('global timeout kills a slow tool; timeoutSeconds 0 or a larger value lets it finish', async () => {
    const tools = [slow('slow_default'), slow('slow_unlimited', 0), slow('slow_longer', 3)];
    const { provider } = await runAgent({
      tools,
      config: cfg(),
      script: (_r, i) => (i === 0
        ? { calls: [{ name: 'slow_default' }, { name: 'slow_unlimited' }, { name: 'slow_longer' }] }
        : { text: 'done' }),
    });
    const req2 = provider.requests[1]!;
    expect(F.toolResultsIn(req2, 'slow_default')[0]).toMatch(/^\[TOOL_TIMEOUT\] 'slow_default' exceeded 1s/);
    expect(F.toolResultsIn(req2, 'slow_unlimited')[0]).toBe('slow_unlimited finished');
    expect(F.toolResultsIn(req2, 'slow_longer')[0]).toBe('slow_longer finished');
  }, 15_000);

  it('a no-timeout tool that ignores its signal still does not hang the loop on cancel', async () => {
    const hang = new F.FakeTool('hang', () => new Promise(() => { /* never settles, ignores ctx.signal */ }), { timeoutSeconds: 0 });
    const provider = new F.FakeProvider(() => ({ calls: [{ name: 'hang' }] }));
    const agent = new L.AgentLoop({ router: F.fakeRouter(provider), registry: new F.FakeRegistry([hang]) as any, permissions: F.allowAllPermissions, config: F.testConfig(), cwd });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const events: any[] = [];
    for await (const ev of agent.run([{ role: 'system', content: 's' }, { role: 'user', content: 'x' }], store.createSession(cwd, 'm'), {
      mode: { mode: 'subagent' }, askUser: async () => 'no', signal: ac.signal,
    })) events.push(ev);
    const res = events.find(e => e.type === 'tool_result');
    expect(res?.data?.result).toMatch(/^\[CANCELLED\]/);
  }, 10_000);
});

describe('gate exemptions (end-to-end)', () => {
  it('the architecture gate lets browser actions through but still bounces the first code write', async () => {
    const click = new F.FakeTool('browser_click', () => ({ content: '✓ clicked Export' }));
    const write = new F.FakeTool('write_file', () => ({ content: 'wrote src/x.ts' }));
    const { provider } = await runAgent({
      mode: 'normal',
      prompt: 'Log in to the admin dashboard on example.com and export the monthly report',
      tools: [click, write],
      script: (_r, i) => (i === 0
        ? { calls: [{ name: 'browser_click', args: { ref: 'e3' } }, { name: 'write_file', args: { path: 'src/x.ts', content: 'x' } }] }
        : { text: 'Exported.' }),
    });
    const req2 = provider.requests[1]!;
    expect(F.toolResultsIn(req2, 'browser_click')[0]).toBe('✓ clicked Export');
    expect(F.toolResultsIn(req2, 'write_file')[0]).toMatch(/^\[ARCHITECTURE_GATE\]/);
    expect(click.calls.length).toBe(1);
    expect(write.calls.length).toBe(0);
  });

  it('the per-turn auto-snapshot is taken before the first CODE mutation, not before a browser action', async () => {
    const reasons: string[] = [];
    const click = new F.FakeTool('browser_click', () => ({ content: '✓' }));
    const write = new F.FakeTool('write_file', () => ({ content: 'wrote' }));
    await runAgent({
      tools: [click, write],
      script: (_r, i) => (i === 0
        ? { calls: [{ name: 'browser_click', args: { ref: 'e1' } }, { name: 'write_file', args: { path: 'notes.md', content: 'x' } }] }
        : { text: 'ok' }),
      setup: (agent) => {
        agent.setSessionForSnapshot = () => {};
        agent.snapshotService = { takeSnapshot: (reason: string) => { reasons.push(reason); return { id: 1 }; }, prune: () => {} };
      },
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('before write_file');
  });
});

describe('scope-guard note ordering', () => {
  it('the scope note is appended AFTER the turn\'s tool results (never between a call and its result)', async () => {
    const dev = new F.FakeTool('dev_server_start', () => ({ content: 'started on :5173' }));
    const { provider } = await runAgent({
      mode: 'normal',
      prompt: 'change the hero title to Welcome',
      tools: [dev],
      script: (_r, i) => (i === 0 ? { calls: [{ name: 'dev_server_start', args: {} }] } : { text: 'ok' }),
    });
    const msgs = provider.requests[1]!.messages;
    assertToolPairing(msgs);
    const toolIdx = msgs.findIndex(m => m.role === 'tool');
    const noteIdx = msgs.findIndex(m => m.role === 'user' && String(m.content).includes('not to run a dev server'));
    expect(toolIdx).toBeGreaterThan(0);
    expect(noteIdx).toBeGreaterThan(toolIdx);
  });
});
