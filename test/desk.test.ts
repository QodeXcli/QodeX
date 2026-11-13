import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifySensitive, canHandoff, scrubPacket, validateRoutine, describeDesktop, MAX_DESKS, deskMcpConfig, isDeskToolName } from '../src/desk/policy.js';
import { buildDeskPrompt, claimGoal, createDesk, decideGoal, emptyBoard, handoff, lastTrace, postGoal, releaseGoal, settleGoal, teachRoutine } from '../src/desk/board.js';
import { classifyAsk, decideInFile, emptySentinel, parkSentinel, pollSentinel } from '../src/desk/sentinel.js';
import { mapKeyCombo, x11ClickArgs } from '../src/tools/computer/linux.js';
import { windowsClickScript, windowsKeyScript, windowsSendKeys } from '../src/tools/computer/win.js';
import { handleDeskRequest } from '../src/desk/console.js';
import { withConfiguredMcp } from '../src/desk/dispatch.js';
import { getMCPManager } from '../src/mcp/manager.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { confirmScreenChange } from '../src/tools/computer/use.js';

describe('classifySensitive — Muse-style stop before the machine acts', () => {
  it('lets ordinary coding goals through', () => {
    expect(classifySensitive('rename the parser and add a test').sensitive).toBe(false);
  });
  it('holds spend, delete, send, publish, and credentials — including Persian', () => {
    expect(classifySensitive('buy the domain').sensitive && (classifySensitive('buy the domain') as any).kind).toBe('spend');
    expect((classifySensitive('پرداخت فاکتور') as any).kind).toBe('spend');
    expect((classifySensitive('rm -rf dist') as any).kind).toBe('delete');
    expect((classifySensitive('حذف همه فایل‌ها') as any).kind).toBe('delete');
    expect((classifySensitive('send an email to the client') as any).kind).toBe('send');
    expect((classifySensitive('بفرست برای علی') as any).kind).toBe('send');
    expect((classifySensitive('git push origin main') as any).kind).toBe('publish');
    expect((classifySensitive('paste the api key') as any).kind).toBe('credential');
  });
  it('prefers credential over send when both match', () => {
    const v = classifySensitive('send the api key by email');
    expect(v.sensitive).toBe(true);
    if (v.sensitive) expect(v.kind).toBe('credential');
  });
});

describe('handoff and routines', () => {
  it('refuses self-handoff and depth past the cap', () => {
    expect(canHandoff({ fromId: 'a', toId: 'a', depth: 0, knownIds: ['a'] }).ok).toBe(false);
    expect(canHandoff({ fromId: 'a', toId: 'b', depth: 0, knownIds: ['a'] }).ok).toBe(false);
    expect(canHandoff({ fromId: 'a', toId: 'b', depth: 0, knownIds: ['a', 'b'] }).ok).toBe(true);
    expect(canHandoff({ fromId: 'a', toId: 'b', depth: 3, knownIds: ['a', 'b'] }).ok).toBe(false);
  });
  it('strips secrets from a packet but keeps the work', () => {
    const s = scrubPacket('use sk-abcdefghijklmnopqrstuv and also read src/app.ts');
    expect(s.redacted).toBe(1);
    expect(s.text).not.toContain('sk-abc');
    expect(s.text).toContain('src/app.ts');
  });
  it('rejects a one-step routine and a weird tool name', () => {
    expect(validateRoutine([{ tool: 'read_file', summary: 'look' }]).ok).toBe(false);
    expect(validateRoutine([{ tool: 'Read File', summary: 'x' }, { tool: 'shell', summary: 'y' }]).ok).toBe(false);
    const ok = validateRoutine([{ tool: 'read_file', summary: 'look' }, { tool: 'shell', summary: 'test' }]);
    expect(ok.ok).toBe(true);
    const mcp = validateRoutine([
      { tool: 'mcp:gmail:search_threads', summary: 'find the invoice' },
      { tool: 'mcp:google-drive:list-files', summary: 'open the folder' },
    ]);
    expect(mcp.ok).toBe(true);
    expect(isDeskToolName('mcp:../x:tool')).toBe(false);
    expect(isDeskToolName('Not A Tool')).toBe(false);
  });
  it('starts no MCP server when none are configured or all are disabled', () => {
    expect(deskMcpConfig(undefined)).toBeNull();
    expect(deskMcpConfig({ servers: {} })).toBeNull();
    expect(deskMcpConfig({ servers: { gmail: { enabled: false } } })).toBeNull();
    const on = deskMcpConfig({ servers: { gmail: { enabled: true }, old: { enabled: false } } });
    expect(on?.servers.gmail).toBeTruthy();
    expect(on?.servers.old).toBeUndefined();
  });
  it('does not install an MCP manager when nothing is enabled', async () => {
    const prev = getMCPManager();
    const registry = new ToolRegistry();
    let seen: string[] = ['unset'];
    await withConfiguredMcp(registry, { servers: { gmail: { enabled: false } } }, async (ready) => {
      seen = ready;
      expect(getMCPManager()).toBe(prev);
    });
    expect(seen).toEqual([]);
    expect(getMCPManager()).toBe(prev);
  });
  it('does not claim an X11 backend until xdotool is there, and Windows ships one', () => {
    expect(describeDesktop('linux').gui).toBe('none');
    expect(describeDesktop('linux', { xdotool: true }).gui).toBe('x11');
    expect(describeDesktop('darwin').gui).toBe('macos');
    expect(describeDesktop('win32').gui).toBe('windows');
  });
});

describe('board — desks, holds, handoffs', () => {
  const now = '2026-11-10T00:00:00Z';
  it('caps the team and holds a spend', () => {
    let state = emptyBoard();
    for (let i = 0; i < MAX_DESKS; i++) {
      const res = createDesk(state, { name: `d${i}`, cwd: '/tmp', now });
      expect(res.ok).toBe(true);
      state = res.state;
    }
    expect(createDesk(state, { name: 'overflow', cwd: '/tmp', now }).ok).toBe(false);
    const first = state.desks[0]!;
    const goal = postGoal(state, { deskId: first.id, text: 'purchase the license', now });
    expect(goal.value?.status).toBe('needs-approval');
    const denied = decideGoal(goal.state, { deskId: first.id, goalId: goal.value!.id, allow: false, now });
    expect(denied.value?.status).toBe('denied');
    expect(decideGoal(denied.state, { deskId: first.id, goalId: goal.value!.id, allow: true, now }).ok).toBe(false);
  });
  it('hands work across desks and drops a key on the way', () => {
    let state = emptyBoard();
    state = createDesk(state, { name: 'research', cwd: '/r', now }).state;
    state = createDesk(state, { name: 'writer', cwd: '/w', now }).state;
    state = postGoal(state, { deskId: 'research', text: 'summarize the RFC', now }).state;
    const moved = handoff(state, { fromId: 'research', toId: 'writer', note: 'token=supersecret123 do the writeup', now });
    expect(moved.ok).toBe(true);
    expect(moved.value?.status).toBe('needs-approval');
    expect(moved.value?.text).not.toContain('supersecret');
    expect(moved.value?.text).toContain('[redacted]');
    const research = moved.state.desks.find(d => d.id === 'research')!;
    expect(research.goals[0]!.status).toBe('handed-off');
  });
  it('teaches a routine onto one desk only', () => {
    let state = createDesk(emptyBoard(), { name: 'inbox', cwd: '/in', now }).state;
    const taught = teachRoutine(state, {
      deskId: 'inbox',
      name: 'morning',
      now,
      steps: [
        { tool: 'web_search', summary: 'scan overnight mail subjects' },
        { tool: 'remember', summary: 'store the three that need a reply' },
      ],
    });
    expect(taught.ok).toBe(true);
    expect(taught.state.desks[0]!.routines).toHaveLength(1);
  });
  it('claims a normal goal, skips a held one, and scrubs the result', () => {
    let state = createDesk(emptyBoard(), { name: 'repo', cwd: '/work', now }).state;
    state = postGoal(state, { deskId: 'repo', text: 'buy a domain', now }).state;
    state = postGoal(state, { deskId: 'repo', text: 'rename the parser', now }).state;
    const claimed = claimGoal(state, { deskId: 'repo', now });
    expect(claimed.ok).toBe(true);
    expect(claimed.value?.text).toContain('rename');
    expect(claimed.value?.status).toBe('running');
    expect(claimGoal(claimed.state, { deskId: 'repo', now }).ok).toBe(false);
    const settled = settleGoal(claimed.state, {
      deskId: 'repo', goalId: claimed.value!.id, ok: true, summary: 'token=supersecret123 renamed', now,
    });
    expect(settled.value?.status).toBe('done');
    expect(settled.value?.result).not.toContain('supersecret');
    expect(settled.value?.result).toContain('[redacted]');
    expect(settled.value?.resumeAs).toBeUndefined();
  });
  it('puts a killed approved run back to approved, not queued', () => {
    let state = createDesk(emptyBoard(), { name: 'pay', cwd: '/p', now }).state;
    const held = postGoal(state, { deskId: 'pay', text: 'purchase the license', now });
    const allowed = decideGoal(held.state, { deskId: 'pay', goalId: held.value!.id, allow: true, now });
    const claimed = claimGoal(allowed.state, { deskId: 'pay', now });
    const back = releaseGoal(claimed.state, { deskId: 'pay', goalId: claimed.value!.id, now });
    expect(back.value?.status).toBe('approved');
    expect(peekWouldRun(back.state)).toBe(true);
  });
  it('tells the agent this is the local machine and names the other desk only', () => {
    let state = createDesk(emptyBoard(), { name: 'research', brief: 'read', cwd: '/r', now }).state;
    state = createDesk(state, { name: 'writer', brief: 'draft the notes', cwd: '/w', now }).state;
    const goal = postGoal(state, { deskId: 'research', text: 'summarize the RFC', now }).value!;
    const prompt = buildDeskPrompt({
      desk: state.desks[0]!,
      goal,
      teammates: [{ name: 'writer', brief: 'draft the notes' }],
      desktop: describeDesktop('linux'),
      sharedDir: '/shared-computer',
    });
    expect(prompt).toContain('share this computer');
    expect(prompt).toContain('/shared-computer');
    expect(prompt).toContain('/r');
    expect(prompt).toContain('writer');
    expect(prompt).toContain('NEEDS_APPROVAL');
    expect(prompt).toContain('allow-call');
    expect(prompt).toContain('GUI backend is "none"');
    expect(prompt).not.toContain('/w');
  });
  it('keeps a scrubbed tool trace the teach command can replay', () => {
    let state = createDesk(emptyBoard(), { name: 'repo', cwd: '/work', now }).state;
    state = postGoal(state, { deskId: 'repo', text: 'rename the parser', now }).state;
    const claimed = claimGoal(state, { deskId: 'repo', now });
    const settled = settleGoal(claimed.state, {
      deskId: 'repo',
      goalId: claimed.value!.id,
      ok: true,
      summary: 'renamed',
      now,
      trace: [
        { tool: 'shell', summary: 'token=supersecret123 rg parser' },
        { tool: 'edit_text', summary: 'rename the symbol' },
      ],
    });
    expect(settled.value?.trace?.[0]?.summary).not.toContain('supersecret');
    expect(settled.value?.trace?.[0]?.summary).toContain('[redacted]');
    expect(lastTrace(settled.state.desks[0])).toHaveLength(2);
  });
});

function peekWouldRun(state: ReturnType<typeof emptyBoard>): boolean {
  return state.desks.some(d => d.goals.some(g => g.status === 'approved' || g.status === 'queued'));
}

describe('desk console auth', () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-desk-'));
    prev = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('rejects a request with no token and accepts a create with one', async () => {
    const denied = await handleDeskRequest({
      method: 'POST', pathname: '/api/action', tokenOk: false, rawBody: '{}', contentType: 'application/json', cwd: '/work',
    });
    expect(denied.status).toBe(401);
    const created = await handleDeskRequest({
      method: 'POST', pathname: '/api/action', tokenOk: true,
      rawBody: JSON.stringify({ action: 'create', name: 'repo', brief: 'this codebase' }),
      contentType: 'application/json', cwd: '/work',
    });
    expect(created.status).toBe(200);
    const page = await handleDeskRequest({
      method: 'GET', pathname: '/', tokenOk: true, rawBody: '', contentType: '', cwd: '/work',
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('repo');
    expect(page.body).toContain('میز کار');
    expect(page.body).toContain('qodex desk run');
  });

  it('escapes a desk name instead of treating it as HTML', async () => {
    const created = await handleDeskRequest({
      method: 'POST', pathname: '/api/action', tokenOk: true,
      rawBody: JSON.stringify({ action: 'create', name: '<script>', brief: 'x' }),
      contentType: 'application/json', cwd: '/work',
    });
    expect(created.status).toBe(200);
    const page = await handleDeskRequest({
      method: 'GET', pathname: '/', tokenOk: true, rawBody: '', contentType: '', cwd: '/work',
    });
    const lt = String.fromCharCode(38) + 'lt;';
    const gt = String.fromCharCode(38) + 'gt;';
    expect(page.body).toContain('<h2>' + lt + 'script' + gt + '</h2>');
    expect(page.body).toContain(lt + 'script' + gt);
  });
});

describe('screen click, type, and key ask every time', () => {
  const ctx = (answer: string) => ({ askUser: async () => answer, emit: () => {} }) as any;
  it('rejects no, and rejects a standing always-yes', async () => {
    expect((await confirmScreenChange(ctx('no'), 'computer_use_click', 'click 1,2'))?.isError).toBe(true);
    expect((await confirmScreenChange(ctx('always yes'), 'computer_use_type', 'type'))?.isError).toBe(true);
  });
  it('accepts one yes', async () => {
    expect(await confirmScreenChange(ctx('yes'), 'computer_use_key', 'key cmd+s')).toBeNull();
  });
});

describe('sentinel and desktop backends', () => {
  it('labels a screen ask and a purchase, and decides a parked call once', async () => {
    expect(classifyAsk('computer_use_click will change what is on screen: click 1,2').kind).toBe('screen');
    expect(classifyAsk('browser_click will change the page: text=Save').kind).toBe('page');
    expect(classifyAsk('Run: npm publish qodex').kind).toBe('publish');
    let file = emptySentinel();
    file = {
      ...file,
      requests: [{ id: 'ab', deskId: 'd', goalId: 'g', prompt: 'click', kind: 'screen', reason: 'screen', status: 'pending', createdAt: 't' }],
    };
    const yes = decideInFile(file, 'ab', true, 't2');
    expect(yes.ok && yes.request.status).toBe('allowed');
    if (yes.ok) expect(decideInFile(yes.file, 'ab', false, 't3').ok).toBe(false);
    const polled = await pollSentinel('ab', {
      timeoutMs: 0,
      pollMs: 1,
      load: async () => ({ id: 'ab', deskId: 'd', goalId: 'g', prompt: 'x', kind: 'ask', reason: 'ask', status: 'pending', createdAt: 't' }),
      sleep: async () => {},
      now: () => 0,
    });
    expect(polled).toBe('timeout');
    const passed = await pollSentinel('ab', {
      timeoutMs: 0,
      pollMs: 1,
      load: async () => ({ id: 'ab', deskId: 'd', goalId: 'g', prompt: 'x', kind: 'ask', reason: 'ask', status: 'allowed', createdAt: 't' }),
      sleep: async () => {},
    });
    expect(passed).toBe('allowed');
  });

  it('builds real xdotool and Win32 calls', () => {
    expect(mapKeyCombo('cmd+s')).toBe('super+s');
    expect(x11ClickArgs(12, 40, 'left', 2)).toEqual(['mousemove', '--sync', '12', '40', 'click', '--repeat', '2', '--delay', '80', '1']);
    expect(windowsSendKeys('ctrl+s')).toBe('^s');
    expect(windowsSendKeys('super+r')).toBeNull();
    const win = windowsKeyScript('win+e');
    expect(win).toContain('0x5B');
    expect(win).toContain('0x45');
    expect(win).not.toContain('SendKeys');
    expect(windowsKeyScript('win')).toBeNull();
    expect(windowsKeyScript('ctrl+s')).toContain('SendKeys');
    const script = windowsClickScript(12, 40, 'left', 1);
    expect(script).toContain('SetCursorPos(12, 40)');
  });
});
