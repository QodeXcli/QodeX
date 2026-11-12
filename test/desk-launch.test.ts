import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { handleDeskRequest } from '../src/desk/console.js';
import { launchDesk } from '../src/desk/launch.js';
import { loadBoard } from '../src/desk/store.js';

describe('launchDesk', () => {
  let home: string;
  let prev: string | undefined;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'qodex-launch-'));
    prev = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  async function desk(name: string) {
    const created = await handleDeskRequest({
      method: 'POST', pathname: '/api/action', tokenOk: true,
      rawBody: JSON.stringify({ action: 'create', name, brief: 'work' }),
      contentType: 'application/json', cwd: home,
    });
    expect(created.status).toBe(200);
  }

  it('does not claim a held goal and does not call the runner', async () => {
    await desk('inbox');
    await handleDeskRequest({
      method: 'POST', pathname: '/api/action', tokenOk: true,
      rawBody: JSON.stringify({ action: 'goal', deskId: 'inbox', text: 'send an email to the team' }),
      contentType: 'application/json', cwd: home,
    });
    let called = false;
    const started = await launchDesk('inbox', async () => { called = true; return { code: 0, trace: [] }; });
    expect(started.ok).toBe(false);
    expect(started.message).toContain('held');
    expect(called).toBe(false);
    expect((await loadBoard()).desks[0]!.goals[0]!.status).toBe('needs-approval');
  });

  it('claims a runnable goal, runs it, and records the exit without a second run overlapping', async () => {
    await desk('repo');
    await handleDeskRequest({
      method: 'POST', pathname: '/api/action', tokenOk: true,
      rawBody: JSON.stringify({ action: 'goal', deskId: 'repo', text: 'read the notes' }),
      contentType: 'application/json', cwd: home,
    });
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const first = await launchDesk('repo', async job => {
      expect(job.prompt).toContain('read the notes');
      expect(job.prompt).toContain('no remote VM');
      await gate;
      return { code: 0, trace: [{ tool: 'read_file', summary: 'notes' }] };
    });
    expect(first.ok).toBe(true);
    expect(first.message).toMatch(/^running /);
    expect((await loadBoard()).desks[0]!.goals[0]!.status).toBe('running');
    const second = await launchDesk('repo', async () => ({ code: 0, trace: [] }));
    expect(second.ok).toBe(false);
    expect(second.message).toBe('already running');
    release();
    await first.done;
    const goal = (await loadBoard()).desks[0]!.goals[0]!;
    expect(goal.status).toBe('done');
    expect(goal.result).toContain('agent exit 0');
  });
});
