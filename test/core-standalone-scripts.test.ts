/**
 * The core's standalone test scripts (their own `check()` harness + process.exit) are
 * excluded from vitest collection (vitest.config.ts STANDALONE_SCRIPTS) and only ran via
 * `npm run test:scripts` — so `npx vitest run` never exercised the completion gate, the
 * relevance tiers or the task addenda at all. Run each one as a child process here and
 * require a clean exit, so a regression in them fails the main suite.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const SCRIPTS = ['completion-gate', 'tool-relevance', 'task-addenda', 'prompt-tiering'];

describe('core standalone test scripts', () => {
  for (const name of SCRIPTS) {
    it(`test/${name}.test.ts passes`, () => {
      const r = spawnSync(process.execPath, [tsxCli, path.join(here, `${name}.test.ts`)], {
        cwd: path.join(here, '..'),
        encoding: 'utf-8',
        timeout: 120_000,
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const failedLines = out.split('\n').filter(l => /^\s*✗/.test(l));
      expect(failedLines, out.slice(-2000)).toEqual([]);
      expect(r.status, out.slice(-2000)).toBe(0);
      expect(out).toMatch(/\d+ passed, 0 failed/);
    }, 120_000);
  }
});
