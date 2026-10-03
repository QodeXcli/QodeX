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

describe('code_run in auto mode', () => {
  it('the snippet is analyzed like the equivalent command line', async () => {
    const { codeRunCommandLine } = await import('../src/tools/shell/code-run.js');
    setApprovalMode('auto');
    const e = new PermissionEngine(DEFAULT_CONFIG);
    const run = (language: string, code: string, cwd?: string) =>
      e.evaluate({ tool: 'code_run', operation: codeRunCommandLine({ language, code, cwd }), cwd: '/work/app' });
    expect(run('python', 'print(2 + 2)')).toBe('allow');
    expect(run('python', "import shutil; shutil.rmtree('/etc/qodex-test')")).toBe('ask');
    expect(run('node', "require('fs').rmSync('/etc/qodex-test', { recursive: true })")).toBe('ask');
    expect(run('bash', 'rm -rf ~/qodex-test')).toBe('ask');
    expect(run('bash', "echo it's fine > out.txt")).toBe('allow');
    expect(run('python', "open('notes.txt', 'w').write('x')")).toBe('allow');
  });

  it('the tool refuses outside-project deletes with no human and runs ordinary code', async () => {
    if (process.platform === 'darwin') return; // sandbox-exec confines writes there
    const { CodeRunTool } = await import('../src/tools/shell/code-run.js');
    const { setInteractiveHuman } = await import('../src/control/approvals.js');
    setApprovalMode('auto');
    setInteractiveHuman(false);
    try {
      let asked = 0;
      const ctx: any = {
        cwd: process.cwd(), sessionId: 's1', permissions: new PermissionEngine(DEFAULT_CONFIG),
        askUser: async () => { asked++; return 'yes'; }, emit: () => {},
      };
      const tool = new CodeRunTool();
      const bad = await tool.execute({ language: 'python', code: "import shutil; shutil.rmtree('/etc/qodex-never')" } as any, ctx);
      expect(bad.isError).toBe(true);
      expect(String(bad.content)).toMatch(/AUTO_MODE_NEEDS_HUMAN/);
      expect(asked).toBe(0);
      const ok = await tool.execute({ language: 'bash', code: 'echo $((40 + 2))' } as any, ctx);
      expect(String(ok.content)).toContain('42');
    } finally { setInteractiveHuman(false); }
  });
});
