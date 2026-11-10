/**
 * Witnessed replay — the single-model promotion gate.
 *
 * A patch is re-applied in a detached worktree. Promotion requires an injected
 * checker here so the test does not depend on tsc/ruff being installed.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  parseDiffFiles,
  sanitizeWitnessPatch,
  extractWitnessPatch,
  verdictFromReplay,
  replayWitness,
  upsertWitnessSection,
  formatWitnessSection,
} from '../src/skills/learning/witness.js';
import { decidePromotion } from '../src/skills/learning/promotion.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function repoWithPatch(): Promise<{ dir: string; patch: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-witness-repo-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'witness@qodex.test']);
  git(dir, ['config', 'user.name', 'witness']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'init']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello\nworld\n', 'utf8');
  const patch = git(dir, ['diff']);
  git(dir, ['checkout', '--', 'a.txt']);
  return { dir, patch };
}

function skillMd(patch: string): string {
  return `---\nname: t\ndescription: t\nprovenance: machine\nstatus: candidate\n---\n\n## Witness patch\n\n\`\`\`diff\n${patch.trimEnd()}\n\`\`\`\n`;
}

describe('sanitizeWitnessPatch', () => {
  it('rejects traversal, secrets, and non-diffs', () => {
    expect(sanitizeWitnessPatch('').ok).toBe(false);
    expect(sanitizeWitnessPatch('hello world').ok).toBe(false);
    const escape = sanitizeWitnessPatch('diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n');
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.reason).toMatch(/unsafe path/);
    const secret = sanitizeWitnessPatch('diff --git a/k.env b/k.env\n--- a/k.env\n+++ b/k.env\n@@ -0,0 +1 @@\n+AKIAIOSFODNN7EXAMPLE\n');
    expect(secret.ok).toBe(false);
  });

  it('parses the destination path of a normal diff', () => {
    const patch = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const s = sanitizeWitnessPatch(patch);
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.files).toEqual(['src/a.ts']);
    expect(parseDiffFiles(patch)).toEqual(['src/a.ts']);
  });
});

describe('verdictFromReplay', () => {
  it('passes only when a checker ran clean on at least one file', () => {
    expect(verdictFromReplay({
      apply: 'applied', files: 1, at: 't',
      verify: { ran: true, errorCount: 0, checker: 'tsc' },
    }).pass).toBe(true);
    expect(verdictFromReplay({
      apply: 'applied', files: 1, at: 't',
      verify: { ran: false, errorCount: 0 },
    }).pass).toBe(false);
    expect(verdictFromReplay({ apply: 'conflict', files: 1, at: 't' }).pass).toBe(false);
  });
});

describe('replayWitness — real git, injected checker', () => {
  it('re-applies the captured diff and promotes only when the checker is clean', async () => {
    const { dir, patch } = await repoWithPatch();
    try {
      expect(extractWitnessPatch(skillMd(patch))).toContain('world');
      const pass = await replayWitness(dir, skillMd(patch), {
        at: '2026-11-10T00:00:00Z',
        verify: async () => ({ ran: true, errorCount: 0, checker: 'fixture', diagnostics: [] }),
      });
      expect(pass.replay).toBe('applied');
      expect(pass.pass).toBe(true);
      expect(pass.files).toBeGreaterThan(0);
      const decision = decidePromotion({ authorModel: 'qwen', verdict: null, witness: pass });
      expect(decision.promote).toBe(true);

      const dirty = await replayWitness(dir, skillMd(patch), {
        verify: async () => ({ ran: true, errorCount: 2, checker: 'fixture', diagnostics: [{ message: 'boom' }] }),
      });
      expect(dirty.pass).toBe(false);
      expect(decidePromotion({ authorModel: 'qwen', verdict: null, witness: dirty }).promote).toBe(false);

      const recorded = upsertWitnessSection(skillMd(patch), formatWitnessSection(pass));
      expect(recorded).toContain('## Witness replay');
      expect(recorded).toContain('- pass: true');
      // working tree stayed clean
      expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('hello\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports conflict when the tree has moved on', async () => {
    const { dir, patch } = await repoWithPatch();
    try {
      await fs.writeFile(path.join(dir, 'a.txt'), 'completely different\n', 'utf8');
      git(dir, ['add', 'a.txt']);
      git(dir, ['commit', '-m', 'drift']);
      const v = await replayWitness(dir, skillMd(patch), {
        verify: async () => ({ ran: true, errorCount: 0, checker: 'fixture', diagnostics: [] }),
      });
      expect(v.replay).toBe('conflict');
      expect(v.pass).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
