import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { GitStatusTool } from '../src/tools/git/status.js';
import { GitDiffTool } from '../src/tools/git/diff.js';
import { GitLogTool } from '../src/tools/git/log.js';
import { GitBranchTool } from '../src/tools/git/branch.js';
import { GitCommitTool } from '../src/tools/git/commit.js';
import type { ToolContext } from '../src/tools/base.js';

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: 'test',
    transaction: {} as any,
    permissions: { check: () => ({ ok: true }) } as any,
    askUser: async () => 'allow',
    signal: new AbortController().signal,
    emit: () => {},
  } as ToolContext;
}

/** Run a git command synchronously in the given dir for test setup. */
function gitSetup(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
}

describe('Git tools — using a real temp repo', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-gittest-'));
    gitSetup(repo, ['init', '-b', 'main']);
    gitSetup(repo, ['config', 'user.email', 'test@qodex.local']);
    gitSetup(repo, ['config', 'user.name', 'QodeX Test']);
    gitSetup(repo, ['config', 'commit.gpgsign', 'false']);
    await fs.writeFile(path.join(repo, 'README.md'), '# initial\n');
    gitSetup(repo, ['add', 'README.md']);
    gitSetup(repo, ['commit', '-m', 'initial commit']);
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  // ─────── git_status ───────

  it('git_status reports a clean working tree on a fresh repo', async () => {
    const r = await new GitStatusTool().execute({}, makeCtx(repo));
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Branch: main/);
    expect(r.content).toMatch(/Working tree clean/);
  });

  it('git_status sees staged, unstaged, and untracked files', async () => {
    // Unstaged modification
    await fs.writeFile(path.join(repo, 'README.md'), '# initial\nmodified\n');
    // Staged new file
    await fs.writeFile(path.join(repo, 'staged.ts'), 'export const x = 1;\n');
    gitSetup(repo, ['add', 'staged.ts']);
    // Untracked
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'hello');

    const r = await new GitStatusTool().execute({}, makeCtx(repo));
    expect(r.content).toContain('Staged:');
    expect(r.content).toContain('staged.ts');
    expect(r.content).toContain('Unstaged:');
    expect(r.content).toContain('README.md');
    expect(r.content).toContain('Untracked:');
    expect(r.content).toContain('untracked.txt');
    expect((r.metadata as any).staged).toBe(1);
    expect((r.metadata as any).unstaged).toBe(1);
    expect((r.metadata as any).untracked).toBe(1);
  });

  it('git_status returns NOT_A_GIT_REPO outside a repo', async () => {
    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-notrepo-'));
    try {
      const r = await new GitStatusTool().execute({}, makeCtx(nonRepo));
      expect(r.isError).toBe(true);
      expect(r.content).toContain('NOT_A_GIT_REPO');
    } finally {
      await fs.rm(nonRepo, { recursive: true, force: true });
    }
  });

  // ─────── git_diff ───────

  it('git_diff scope=unstaged returns patch with added lines', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# initial\nadded line\n');
    const r = await new GitDiffTool().execute({ scope: 'unstaged' }, makeCtx(repo));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('diff --git');
    expect(r.content).toContain('+added line');
  });

  it('git_diff scope=staged works after add', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# changed\n');
    gitSetup(repo, ['add', 'README.md']);
    const r = await new GitDiffTool().execute({ scope: 'staged' }, makeCtx(repo));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('# changed');
    // unstaged should now be empty
    const r2 = await new GitDiffTool().execute({ scope: 'unstaged' }, makeCtx(repo));
    expect(r2.content).toContain('NO_CHANGES');
  });

  it('git_diff mode=stat returns a summary, not a full patch', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# initial\nmore\nlines\nhere\n');
    const r = await new GitDiffTool().execute({ scope: 'unstaged', mode: 'stat' }, makeCtx(repo));
    expect(r.content).toContain('README.md');
    expect(r.content).toContain('insertion');
    expect(r.content).not.toContain('diff --git');
  });

  it('git_diff truncates large patches', async () => {
    // Build a huge diff
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await fs.writeFile(path.join(repo, 'big.txt'), big);
    gitSetup(repo, ['add', 'big.txt']);
    gitSetup(repo, ['commit', '-m', 'add big']);
    // Now modify and diff
    const big2 = Array.from({ length: 5000 }, (_, i) => `line ${i} CHANGED`).join('\n') + '\n';
    await fs.writeFile(path.join(repo, 'big.txt'), big2);

    const r = await new GitDiffTool().execute({ scope: 'unstaged', max_bytes: 5000 }, makeCtx(repo));
    expect(r.content.length).toBeLessThan(8000); // 5000 + trailing note
    expect(r.content).toContain('truncated');
    expect((r.metadata as any).truncated).toBe(true);
  });

  // ─────── git_log ───────

  it('git_log lists the initial commit', async () => {
    const r = await new GitLogTool().execute({ limit: 10 }, makeCtx(repo));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('initial commit');
    expect((r.metadata as any).count).toBe(1);
  });

  it('git_log filters by author', async () => {
    const r = await new GitLogTool().execute({ author: 'nobody-by-this-name' }, makeCtx(repo));
    expect(r.content).toContain('NO_COMMITS');
  });

  // ─────── git_branch ───────

  it('git_branch action=current returns "main"', async () => {
    const r = await new GitBranchTool().execute({ action: 'current' }, makeCtx(repo));
    expect(r.content.trim()).toBe('main');
  });

  it('git_branch list/create/checkout/delete round-trip', async () => {
    // create
    const cr = await new GitBranchTool().execute({ action: 'create', name: 'feat/x' }, makeCtx(repo));
    expect(cr.content).toContain("Created branch 'feat/x'");
    // list shows it
    const lr = await new GitBranchTool().execute({ action: 'list' }, makeCtx(repo));
    expect(lr.content).toContain('feat/x');
    // checkout
    const ck = await new GitBranchTool().execute({ action: 'checkout', name: 'feat/x' }, makeCtx(repo));
    expect(ck.content).toContain("Switched to branch 'feat/x'");
    // back to main, then delete
    await new GitBranchTool().execute({ action: 'checkout', name: 'main' }, makeCtx(repo));
    const dr = await new GitBranchTool().execute({ action: 'delete', name: 'feat/x' }, makeCtx(repo));
    expect(dr.content).toContain("Deleted branch 'feat/x'");
  });

  it('git_branch action=checkout with create_if_missing creates and switches', async () => {
    const r = await new GitBranchTool().execute(
      { action: 'checkout', name: 'feat/new-thing', create_if_missing: true },
      makeCtx(repo),
    );
    expect(r.content).toContain('feat/new-thing');
    // Verify it's now current
    const cur = await new GitBranchTool().execute({ action: 'current' }, makeCtx(repo));
    expect(cur.content.trim()).toBe('feat/new-thing');
  });

  // ─────── git_commit ───────

  it('git_commit refuses when nothing is staged', async () => {
    const r = await new GitCommitTool().execute({ message: 'wip' }, makeCtx(repo));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('NOTHING_STAGED');
  });

  it('git_commit creates a commit when paths are passed', async () => {
    await fs.writeFile(path.join(repo, 'new.ts'), 'export const v = 1;\n');
    const r = await new GitCommitTool().execute(
      { message: 'feat: add new.ts', paths: ['new.ts'] },
      makeCtx(repo),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/Created commit [0-9a-f]{7,}/);
    expect(r.content).toContain('feat: add new.ts');
  });

  it('git_commit with stage_all picks up modifications but not untracked', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# changed\n');
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'should not commit');
    const r = await new GitCommitTool().execute(
      { message: 'docs: update readme', stage_all: true },
      makeCtx(repo),
    );
    expect(r.isError).toBeFalsy();
    // Verify the untracked file is still untracked
    const status = await new GitStatusTool().execute({}, makeCtx(repo));
    expect(status.content).toContain('untracked.txt');
  });

  it('git_commit supports multi-line messages (passed via stdin so no shell escaping)', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    const r = await new GitCommitTool().execute(
      {
        message: 'feat: multi\n\nBody paragraph with "quotes" and $vars and `backticks`.\n',
        paths: ['a.txt'],
      },
      makeCtx(repo),
    );
    expect(r.isError).toBeFalsy();
    // Verify the body landed correctly
    const logR = spawnSync('git', ['-C', repo, 'log', '-1', '--pretty=%B'], { encoding: 'utf-8' });
    expect(logR.stdout).toContain('Body paragraph with "quotes"');
    expect(logR.stdout).toContain('$vars');
    expect(logR.stdout).toContain('`backticks`');
  });
});
