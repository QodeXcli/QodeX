import { describe, it, expect, afterEach } from 'vitest';
import { PermissionEngine, setApprovalMode } from '../src/security/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { whyLine } from '../src/security/human-approval.js';
import { isAutoModeAskPrompt } from '../src/sentinel/auto-mode.js';

afterEach(() => setApprovalMode('manual'));

const sh = (operation: string) => ({ tool: 'shell', operation, cwd: '/work/app' });

describe('hard deny only for the filesystem root', () => {
  it('rm -rf of / or /* is denied in every mode; other absolute paths follow the mode policy', () => {
    for (const mode of ['manual', 'edits', 'auto'] as const) {
      setApprovalMode(mode);
      const e = new PermissionEngine(DEFAULT_CONFIG);
      for (const c of ['rm -rf /', 'rm -rf /*', 'rm -fr /', 'sudo rm -rf / ', 'rm -rf --no-preserve-root /', 'chmod -R 777 /']) {
        expect(e.evaluate(sh(c)), `${mode}: ${c}`).toBe('deny');
      }
      expect(e.evaluate(sh('rm -rf /etc/qodex-test')), mode).not.toBe('deny');
      expect(e.evaluate(sh('chmod -R 777 /var/www')), mode).not.toBe('deny');
    }
    setApprovalMode('auto');
    const e = new PermissionEngine(DEFAULT_CONFIG);
    expect(e.evaluate(sh('rm -rf /tmp/qodex-build'))).toBe('allow');           // temp dir is a root
    expect(e.evaluate(sh('rm -rf /work/app/dist'))).toBe('allow');             // inside the project
    expect(e.evaluate(sh('rm -rf /etc/qodex-test'))).toBe('ask');              // outside the project
  });
});

describe('auto-mode asks carry the marker channels match on', () => {
  it('whyLine', () => {
    const auto = whyLine({ reason: 'deletes ~/x (outside the project)', autoPolicy: true });
    expect(isAutoModeAskPrompt(`Run: rm -rf ~/x${auto}`)).toBe(true);
    expect(whyLine({ reason: 'manual mode asks before shell commands', autoPolicy: false })).toBe('\n  Why: manual mode asks before shell commands');
    expect(whyLine({ autoPolicy: true })).toBe('');
  });
});
