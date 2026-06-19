import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { GitSandbox } from '../src/agent/git-sandbox.js';

function gitInit(dir: string) {
  const run = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.email', 't@t.com']);
  run(['config', 'user.name', 't']);
  run(['config', 'commit.gpgsign', 'false']);
}

describe('GitSandbox', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-test-'));
    gitInit(dir);
    await fs.writeFile(path.join(dir, 'file.txt'), 'v1\n');
    execFileSync('git', ['-C', dir, 'add', '-A']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'initial']);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('begins on an isolated branch and merges a successful task back', async () => {
    const sb = new GitSandbox(dir);
    const ok = await sb.begin('task1');
    expect(ok).toBe(true);
    expect(sb.branch).toMatch(/^qodex\/sandbox-task1/);

    // simulate the agent editing a file
    await fs.writeFile(path.join(dir, 'file.txt'), 'v2-done\n');
    const { merged } = await sb.finish(true, 'qodex: did the thing');
    expect(merged).toBe(true);

    // back on the original branch with merged content, sandbox branch gone
    const branches = execFileSync('git', ['-C', dir, 'branch'], { encoding: 'utf-8' });
    expect(branches).not.toMatch(/sandbox-task1/);
    const content = await fs.readFile(path.join(dir, 'file.txt'), 'utf-8');
    expect(content).toBe('v2-done\n');
  });

  it('abandons a failed task and restores original state', async () => {
    const sb = new GitSandbox(dir);
    await sb.begin('task2');
    await fs.writeFile(path.join(dir, 'file.txt'), 'garbage-experiment\n');
    const { merged } = await sb.finish(false, 'should not merge');
    expect(merged).toBe(false);

    // original content intact, branch removed
    const content = await fs.readFile(path.join(dir, 'file.txt'), 'utf-8');
    expect(content).toBe('v1\n');
    const branches = execFileSync('git', ['-C', dir, 'branch'], { encoding: 'utf-8' });
    expect(branches).not.toMatch(/sandbox-task2/);
  });

  it('backtracks to a checkpoint', async () => {
    const sb = new GitSandbox(dir);
    await sb.begin('task3');
    await fs.writeFile(path.join(dir, 'file.txt'), 'good\n');
    await sb.checkpoint('good state');
    await fs.writeFile(path.join(dir, 'file.txt'), 'bad-dead-end\n');
    await sb.backtrack();
    const content = await fs.readFile(path.join(dir, 'file.txt'), 'utf-8');
    expect(content).toBe('good\n'); // reverted to checkpoint
    await sb.finish(false, 'cleanup');
  });

  it('returns false for a non-git directory (no isolation)', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'plain-'));
    const sb = new GitSandbox(plain);
    expect(await sb.begin('x')).toBe(false);
    await fs.rm(plain, { recursive: true, force: true });
  });
});
