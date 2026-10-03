import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';

// Exercise install.sh's control flow in DRY-RUN mode (no clone/build/link actually runs),
// so the one-line installer is covered without touching the system.
const SCRIPT = path.resolve(process.cwd(), 'install.sh');

function runInstaller(env: Record<string, string> = {}): string {
  return execFileSync('bash', [SCRIPT], {
    env: { ...process.env, QODEX_DRY_RUN: '1', ...env },
    encoding: 'utf8',
  });
}

describe('install.sh (dry-run)', () => {
  it('parses without syntax errors', () => {
    // bash -n exits non-zero (throwing) on a syntax error.
    expect(() => execFileSync('bash', ['-n', SCRIPT])).not.toThrow();
  });

  it('runs the four phases and points at the real repo', () => {
    const out = runInstaller({ QODEX_SRC_DIR: '/tmp/qx-test' });
    expect(out).toContain('QodeX installer');
    expect(out).toContain('Checking prerequisites');
    expect(out).toContain('git clone --depth 1 --branch main https://github.com/QodeXcli/QodeX.git /tmp/qx-test');
    expect(out).toContain('npm install && npm run build');
    expect(out).toContain('npm link');
    expect(out).toContain('qodex setup');           // next-steps guidance
    expect(out).toContain('nothing was installed');  // dry-run marker
  });

  it('honors QODEX_BRANCH', () => {
    const out = runInstaller({ QODEX_BRANCH: 'next', QODEX_SRC_DIR: '/tmp/qx-test' });
    expect(out).toContain('--branch next');
  });

  it('QODEX_NO_LINK=1 skips the PATH link step', () => {
    const out = runInstaller({ QODEX_NO_LINK: '1' });
    expect(out).toContain('skipping');
    expect(out).not.toContain('npm link');
  });
});
