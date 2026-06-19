import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { classifyCommit, bucket, formatMarkdown } from '../src/tools/git/classify-commits.js';
import { GenerateReleaseNotesTool } from '../src/tools/git/release-notes.js';
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

function gitSetup(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

function writeAndCommit(repo: string, file: string, content: string, msg: string): void {
  const fp = path.join(repo, file);
  // Sync write for test setup speed
  require('fs').writeFileSync(fp, content);
  gitSetup(repo, ['add', file]);
  gitSetup(repo, ['commit', '-m', msg]);
}

describe('classify-commits', () => {
  const base = { sha: 'abc1234', date: '2026-05-28', author: 'sev', body: '' };

  it('routes conventional feat to features', () => {
    expect(classifyCommit({ ...base, subject: 'feat: add OAuth' }).category).toBe('features');
  });

  it('routes conventional fix to fixes', () => {
    expect(classifyCommit({ ...base, subject: 'fix(parser): handle empty input' }).category).toBe('fixes');
  });

  it('routes bang as breaking', () => {
    expect(classifyCommit({ ...base, subject: 'feat!: drop legacy API' }).category).toBe('breaking');
  });

  it('routes BREAKING CHANGE trailer as breaking', () => {
    const c = classifyCommit({ ...base, subject: 'refactor: extract module', body: 'BREAKING CHANGE: removed foo()' });
    expect(c.category).toBe('breaking');
  });

  it('captures scope from conventional prefix', () => {
    const c = classifyCommit({ ...base, subject: 'feat(auth): new flow' });
    expect(c.scope).toBe('auth');
  });

  it('falls back to heuristic for free-form subjects', () => {
    expect(classifyCommit({ ...base, subject: 'Add dark mode toggle' }).category).toBe('features');
    expect(classifyCommit({ ...base, subject: 'Resolve crash on startup' }).category).toBe('fixes');
    expect(classifyCommit({ ...base, subject: 'Refactor logging module' }).category).toBe('internal');
  });

  it('buckets multiple commits correctly', () => {
    const b = bucket([
      { ...base, subject: 'feat: a' },
      { ...base, subject: 'fix: b' },
      { ...base, subject: 'chore: c' },
      { ...base, subject: 'feat!: d' },
    ]);
    expect(b.features.length).toBe(1);
    expect(b.fixes.length).toBe(1);
    expect(b.internal.length).toBe(1);
    expect(b.breaking.length).toBe(1);
  });

  it('hides internal sections in user scope', () => {
    const b = bucket([
      { ...base, subject: 'feat: visible' },
      { ...base, subject: 'chore: hidden' },
    ]);
    const md = formatMarkdown(b, { scope: 'user', heading: 'v1', range: 'v0..v1' });
    expect(md).toContain('Features');
    expect(md).toContain('visible');
    expect(md).not.toContain('Internal');
    expect(md).not.toContain('hidden');
  });

  it('shows internal sections in all scope', () => {
    const b = bucket([
      { ...base, subject: 'chore: rotate keys' },
    ]);
    const md = formatMarkdown(b, { scope: 'all', heading: 'v1', range: 'v0..v1' });
    expect(md).toContain('Internal');
    expect(md).toContain('rotate keys');
  });

  it('handles empty range gracefully', () => {
    const md = formatMarkdown(bucket([]), { scope: 'user', heading: 'v1', range: 'v0..v1' });
    expect(md).toContain('No user-facing changes');
  });
});

describe('generate_release_notes — end-to-end on a real repo', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-rntest-'));
    gitSetup(repo, ['init', '-b', 'main']);
    gitSetup(repo, ['config', 'user.email', 'test@qodex.local']);
    gitSetup(repo, ['config', 'user.name', 'QodeX Test']);
    gitSetup(repo, ['config', 'commit.gpgsign', 'false']);
    writeAndCommit(repo, 'README.md', 'init', 'chore: initial commit');
    gitSetup(repo, ['tag', 'v0.1.0']);
    writeAndCommit(repo, 'a.txt', 'a', 'feat: add A');
    writeAndCommit(repo, 'b.txt', 'b', 'fix(api): handle null body');
    writeAndCommit(repo, 'c.txt', 'c', 'chore: bump deps');
  });

  it('auto-detects latest tag as `from`', async () => {
    const tool = new GenerateReleaseNotesTool();
    const res = await tool.execute({ scope: 'user' } as any, makeCtx(repo));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Features');
    expect(res.content).toContain('add A');
    expect(res.content).toContain('Fixes');
    expect(res.content).toContain('null body');
    expect(res.content).not.toContain('bump deps'); // hidden in user scope
    expect(res.metadata?.fromSource).toContain('v0.1.0');
  });

  it('prepends to CHANGELOG.md when write_to_changelog=true', async () => {
    const tool = new GenerateReleaseNotesTool();
    const res = await tool.execute({ write_to_changelog: true, heading: 'v0.2.0' } as any, makeCtx(repo));
    expect(res.isError).toBeFalsy();
    const cl = await fs.readFile(path.join(repo, 'CHANGELOG.md'), 'utf-8');
    expect(cl).toContain('# Changelog');
    expect(cl).toContain('## v0.2.0');
    expect(cl).toContain('add A');
  });

  it('bumps package.json version when bump is set', async () => {
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }, null, 2));
    const tool = new GenerateReleaseNotesTool();
    const res = await tool.execute({ bump: 'minor' } as any, makeCtx(repo));
    expect(res.isError).toBeFalsy();
    const pkg = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf-8'));
    expect(pkg.version).toBe('1.3.0');
  });

  it('returns NO_CHANGES on an empty range', async () => {
    const tool = new GenerateReleaseNotesTool();
    const res = await tool.execute({ from: 'HEAD', to: 'HEAD' } as any, makeCtx(repo));
    expect(res.content).toContain('NO_CHANGES');
  });

  it('returns NOT_A_GIT_REPO when cwd is not a repo', async () => {
    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-rntest-bare-'));
    const tool = new GenerateReleaseNotesTool();
    const res = await tool.execute({} as any, makeCtx(nonRepo));
    expect(res.isError).toBe(true);
    expect(res.content).toContain('NOT_A_GIT_REPO');
  });
});
