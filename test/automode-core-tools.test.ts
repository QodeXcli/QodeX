/**
 * The tool side of approvals with a REAL PermissionEngine:
 *   - shell / background_job_start prompts say WHY and offer "always yes" only when it can
 *     help (it switches the session to auto, so never for what auto would still ask);
 *   - auto-policy asks go to a real human: the interactive terminal, else a remote channel
 *     through the broker, else they are refused with [AUTO_MODE_NEEDS_HUMAN] — an
 *     unattended askUser (headless --yes, mission 'auto') is never consulted;
 *   - multi_file_edit goes through the same edit approval as write_file (it had none);
 *   - auto mode snapshots before in-project destructive commands when snapshots are on.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PermissionEngine, setApprovalMode, getApprovalMode } from '../src/security/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { BashTool } from '../src/tools/shell/bash.js';
import { MultiFileEditTool } from '../src/tools/filesystem/multi-file-edit.js';
import { BackgroundJobStartTool } from '../src/tools/builtin/background-jobs.js';
import { confirmEdit } from '../src/tools/filesystem/edit-approval.js';
import { getApprovalBroker, setInteractiveHuman } from '../src/control/approvals.js';

const tmpRoots: string[] = [];
function project(): string {
  // Under the cwd's parent-free temp space would make everything "inside" (the temp dir is a
  // root), so the project lives in a temp dir and "outside" targets live in $HOME.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qx-auto-tools-')));
  tmpRoots.push(d);
  return d;
}
const homeName = () => `.qx-auto-tools-${process.pid}-${Math.random().toString(36).slice(2)}`;
const homeTarget = () => path.join(os.homedir(), homeName());
/** `~/name` — an absolute `rm -rf /…` would hit the hard-deny autoReject pattern instead. */
const homeTilde = () => `~/${homeName()}`;

interface Asked { prompt: string; options: string[] }
function makeCtx(cwd: string, answer: string | ((p: string, o: string[]) => string), extra: Record<string, any> = {}) {
  const asked: Asked[] = [];
  const events: any[] = [];
  const ran: string[] = [];
  const written: Record<string, string> = {};
  const ctx: any = {
    cwd,
    sessionId: 's1',
    permissions: new PermissionEngine(DEFAULT_CONFIG as any),
    askUser: async (prompt: string, options: string[] = []) => {
      asked.push({ prompt, options });
      return typeof answer === 'function' ? answer(prompt, options) : answer;
    },
    emit: (e: any) => events.push(e),
    exec: async (req: any) => { ran.push(req.command); return { code: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false, truncated: false, backend: 'local' }; },
    transaction: {
      write: async (p: string, content: string) => { written[p] = content; fs.writeFileSync(p, content); },
    },
    ...extra,
  };
  return { ctx, asked, events, ran, written };
}

beforeEach(() => { setInteractiveHuman(true); });
afterEach(() => { setApprovalMode('manual'); setInteractiveHuman(false); getApprovalBroker().reset(); });
afterAll(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

describe('shell prompts', () => {
  it('manual: says why and offers always yes for an ordinary command', async () => {
    const { ctx, asked, ran } = makeCtx(project(), 'yes');
    await new BashTool().execute({ command: 'docker compose up' }, ctx);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toMatch(/^Run: docker compose up\n {2}Why: manual mode asks before shell commands/);
    expect(asked[0]!.options).toEqual(['yes', 'no', 'always yes']);
    expect(ran).toEqual(['docker compose up']);
  });

  it('manual: no "always yes" for what auto mode would still ask (force push)', async () => {
    const { ctx, asked, ran } = makeCtx(project(), 'no');
    const r = await new BashTool().execute({ command: 'git push --force origin main' }, ctx);
    expect(asked[0]!.options).toEqual(['yes', 'no']);
    expect(asked[0]!.prompt).toMatch(/Why: force push rewrites remote history/);
    expect(r.content).toMatch(/^\[USER_REJECTED\]/);
    expect(ran).toEqual([]);
  });

  it('manual: an in-project rm -rf (irreversible) still offers always yes — auto would run it', async () => {
    const { ctx, asked } = makeCtx(project(), 'no');
    await new BashTool().execute({ command: 'rm -rf build' }, ctx);
    expect(asked[0]!.options).toEqual(['yes', 'no', 'always yes']);
    expect(asked[0]!.prompt).toMatch(/irreversible/);
  });

  it('"always yes" switches the session to auto (with its policy) and says what still asks', async () => {
    const { ctx, events } = makeCtx(project(), 'always yes');
    await new BashTool().execute({ command: 'docker compose up' }, ctx);
    expect(getApprovalMode()).toBe('auto');
    expect(events.some(e => e.type === 'shell-stderr' && /auto mode is on/.test(e.line))).toBe(true);
    // ...and auto still asks for outside-project destructive work.
    const second = makeCtx(ctx.cwd, 'no');
    second.ctx.permissions = ctx.permissions;
    await new BashTool().execute({ command: `rm -rf ${homeTilde()}` }, second.ctx);
    expect(second.asked).toHaveLength(1);
  });

  it('auto: in-project work runs without a prompt', async () => {
    setApprovalMode('auto');
    const { ctx, asked, ran } = makeCtx(project(), 'no');
    for (const c of ['rm -rf build', 'git reset --hard', 'npm install', 'git push origin main']) {
      await new BashTool().execute({ command: c }, ctx);
    }
    expect(asked).toHaveLength(0);
    expect(ran).toHaveLength(4);
  });

  it('auto + a human at the terminal: outside-project delete asks with the reason, yes/no only', async () => {
    setApprovalMode('auto');
    const target = homeTilde();
    const { ctx, asked, ran } = makeCtx(project(), 'yes');
    await new BashTool().execute({ command: `rm -rf ${target}` }, ctx);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.options).toEqual(['yes', 'no']);
    expect(asked[0]!.prompt).toMatch(/Auto mode still asks: deletes ~\/\.qx-auto-tools-.* \(outside the project\)/);
    expect(ran).toEqual([`rm -rf ${target}`]);
  });

  it('auto + nobody (unattended, no channel): refused with AUTO_MODE_NEEDS_HUMAN; the unattended asker is never asked', async () => {
    setApprovalMode('auto');
    setInteractiveHuman(false);
    const { ctx, asked, ran } = makeCtx(project(), 'yes'); // an auto-answerer that would say yes
    const r = await new BashTool().execute({ command: 'git push --force' }, ctx);
    expect(asked).toHaveLength(0);
    expect(ran).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^\[AUTO_MODE_NEEDS_HUMAN\] Not done: run `git push --force` — force push/);
    expect(r.content).toMatch(/control center/);
  });

  it('auto + a remote channel: the broker carries it to a human; the local auto-answerer is bypassed', async () => {
    setApprovalMode('auto');
    setInteractiveHuman(false);
    const broker = getApprovalBroker();
    const seen: any[] = [];
    broker.registerChannel({ name: 'phone', deliver: (p) => { seen.push(p); setTimeout(() => broker.resolve(p.id, 'yes', 'phone'), 5); } });
    const { ctx, asked, ran } = makeCtx(project(), 'no');
    await new BashTool().execute({ command: 'npm publish' }, ctx);
    expect(asked).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ category: 'auto-mode', source: 'shell', options: ['yes', 'no'] });
    expect(seen[0].prompt).toMatch(/Auto mode still asks: npm publish publishes/);
    expect(ran).toEqual(['npm publish']);
  });

  it('auto: snapshots before an in-project destructive command the old patterns missed', async () => {
    setApprovalMode('auto');
    const snaps: string[] = [];
    const { ctx } = makeCtx(project(), 'no', { snapshotService: { takeSnapshot: (reason: string) => { snaps.push(reason); return {}; } } });
    await new BashTool().execute({ command: 'find . -name "*.o" -exec rm {} +' }, ctx);
    await new BashTool().execute({ command: 'npm test' }, ctx);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatch(/find -exec rm/);
  });
});

describe('background_job_start runs through the same shell permission step', () => {
  it('manual: asks, and a "no" starts nothing', async () => {
    const { ctx, asked } = makeCtx(project(), 'no');
    const r = await new BackgroundJobStartTool().execute({ kind: 'bash', description: 'dev', command: 'docker compose up' }, ctx);
    expect(asked).toHaveLength(1);
    expect(r.content).toMatch(/^\[USER_REJECTED\]/);
  });

  it('auto + nobody: an outside delete is refused', async () => {
    setApprovalMode('auto');
    setInteractiveHuman(false);
    const { ctx } = makeCtx(project(), 'yes');
    const r = await new BackgroundJobStartTool().execute({ kind: 'bash', description: 'x', command: `rm -rf ${homeTilde()}` }, ctx);
    expect(r.content).toMatch(/^\[AUTO_MODE_NEEDS_HUMAN\]/);
  });

  it('auto: in-project work starts without a prompt', async () => {
    setApprovalMode('auto');
    const { ctx, asked } = makeCtx(project(), 'no');
    const r = await new BackgroundJobStartTool().execute({ kind: 'bash', description: 'x', command: 'true' }, ctx);
    expect(asked).toHaveLength(0);
    expect(r.content).toMatch(/^Started bash job/);
  });
});

describe('multi_file_edit goes through edit approval', () => {
  function files(cwd: string) {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha\n');
    fs.writeFileSync(path.join(cwd, 'b.txt'), 'beta\n');
    return [
      { path: 'a.txt', edits: [{ old_string: 'alpha', new_string: 'ALPHA' }] },
      { path: 'b.txt', edits: [{ old_string: 'beta', new_string: 'BETA' }] },
    ];
  }

  it('manual: asks per file (diff + accept options); accept writes both', async () => {
    const cwd = project();
    const { ctx, asked, events } = makeCtx(cwd, 'accept');
    const r = await new MultiFileEditTool().execute({ files: files(cwd) }, ctx);
    expect(r.isError).toBeFalsy();
    expect(asked.map(a => a.prompt.split('\n')[0])).toEqual([
      'Apply 1 edit to a.txt? (file 1/2 of one atomic multi-file edit)',
      'Apply 1 edit to b.txt? (file 2/2 of one atomic multi-file edit)',
    ]);
    expect(asked[0]!.options).toEqual(['accept', 'always yes', 'edit', 'continue', 'reject']);
    expect(events.filter(e => e.type === 'diff')).toHaveLength(2);
    expect(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8')).toBe('BETA\n');
  });

  it('manual: rejecting the second file writes NOTHING (still all-or-nothing)', async () => {
    const cwd = project();
    let n = 0;
    const { ctx } = makeCtx(cwd, () => (++n === 1 ? 'accept' : 'reject'));
    const r = await new MultiFileEditTool().execute({ files: files(cwd) }, ctx);
    expect(r.content).toMatch(/^\[USER_REJECTED\].*NO files were modified/);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('alpha\n');
  });

  it('edits / auto: inside the project no prompt; an absolute path outside asks (no always yes)', async () => {
    const cwd = project();
    setApprovalMode('edits');
    const one = makeCtx(cwd, 'reject');
    await new MultiFileEditTool().execute({ files: files(cwd) }, one.ctx);
    expect(one.asked).toHaveLength(0);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('ALPHA\n');

    setApprovalMode('auto');
    const outside = homeTarget();
    fs.writeFileSync(outside, 'gamma\n');
    try {
      const two = makeCtx(cwd, 'reject');
      const r = await new MultiFileEditTool().execute({ files: [{ path: outside, edits: [{ old_string: 'gamma', new_string: 'G' }] }] }, two.ctx);
      expect(two.asked).toHaveLength(1);
      expect(two.asked[0]!.options).not.toContain('always yes');
      expect(two.asked[0]!.prompt).toMatch(/Auto mode still asks: writes ~\/\.qx-auto-tools-.* \(outside the project\)/);
      expect(r.content).toMatch(/^\[USER_REJECTED\]/);
      expect(fs.readFileSync(outside, 'utf8')).toBe('gamma\n');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('auto + nobody: an outside edit is refused with the needs-human message', async () => {
    setApprovalMode('auto');
    setInteractiveHuman(false);
    const cwd = project();
    const outside = homeTarget();
    fs.writeFileSync(outside, 'gamma\n');
    try {
      const { ctx, asked } = makeCtx(cwd, 'accept');
      const r = await new MultiFileEditTool().execute({ files: [{ path: outside, edits: [{ old_string: 'gamma', new_string: 'G' }] }] }, ctx);
      expect(asked).toHaveLength(0);
      expect(r.content).toMatch(/^\[AUTO_MODE_NEEDS_HUMAN\]/);
      expect(fs.readFileSync(outside, 'utf8')).toBe('gamma\n');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

describe('confirmEdit (write_file / edit_text / multi_edit)', () => {
  it('shows the reason and drops "always yes" for an outside write; keeps it inside', async () => {
    const cwd = project();
    const { ctx, asked } = makeCtx(cwd, 'reject');
    await confirmEdit(ctx, { rel: 'src/a.ts', before: null, after: 'x', absPath: path.join(cwd, 'src/a.ts'), permReq: { tool: 'write_file', operation: 'src/a.ts' }, label: 'Create src/a.ts?' });
    expect(asked[0]!.options).toContain('always yes');
    expect(asked[0]!.prompt).toMatch(/^Create src\/a\.ts\?\n {2}Why: manual mode asks before file edits/);
    await confirmEdit(ctx, { rel: '../../etc/x', before: null, after: 'x', absPath: '/etc/x', permReq: { tool: 'write_file', operation: '/etc/x' }, label: 'Create /etc/x?' });
    expect(asked[1]!.options).not.toContain('always yes');
  });
});
