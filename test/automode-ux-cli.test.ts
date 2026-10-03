/**
 * CLI approval-mode flags (src/cli/approval-flags.ts + the root program in src/index.ts):
 * --auto, --approval-mode <manual|edits|auto>, -y/--yes (= auto for the headless/TUI run),
 * the user config's approval.defaultMode, and the root-flag hand-back convention
 * (src/cli/root-flags.ts) so `mission start … --auto` stays the subcommand's and
 * `qodex -p … --yes` keeps working. A mini program mirrors src/index.ts's root (index.ts
 * parses argv at import time, so it is not imported here).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Command } from 'commander';
import { handBackRootFlags } from '../src/cli/root-flags.js';
import { approvalModeFromFlags, startupApprovalMode } from '../src/cli/approval-flags.js';
import { getApprovalMode, setApprovalMode } from '../src/security/permissions.js';

afterEach(() => { setApprovalMode('manual'); });

describe('approvalModeFromFlags / startupApprovalMode', () => {
  it('maps the flags', () => {
    expect(approvalModeFromFlags({})).toBeUndefined();
    expect(approvalModeFromFlags({ auto: true })).toBe('auto');
    expect(approvalModeFromFlags({ yes: true })).toBe('auto');
    expect(approvalModeFromFlags({ approvalMode: 'edits' })).toBe('edits');
    expect(approvalModeFromFlags({ approvalMode: 'manual' })).toBe('manual');
    expect(approvalModeFromFlags({ approvalMode: 'AUTO' })).toBe('auto');
    expect(approvalModeFromFlags({ approvalMode: 'auto', auto: true, yes: true })).toBe('auto');
  });

  it('rejects a bad value and a contradiction', () => {
    expect(() => approvalModeFromFlags({ approvalMode: 'bogus' })).toThrow(/manual, edits or auto/);
    expect(() => approvalModeFromFlags({ approvalMode: 'manual', auto: true })).toThrow(/conflicts with --auto/);
    expect(() => approvalModeFromFlags({ approvalMode: 'edits', yes: true })).toThrow(/conflicts with --yes/);
  });

  it('flags beat the user config; the config beats the manual default', () => {
    expect(startupApprovalMode({}, undefined)).toEqual({ mode: 'manual', source: 'default' });
    expect(startupApprovalMode({}, { approval: { defaultMode: 'auto' } })).toEqual({ mode: 'auto', source: 'config' });
    expect(startupApprovalMode({}, { approval: { defaultMode: 'edits' } })).toEqual({ mode: 'edits', source: 'config' });
    expect(startupApprovalMode({}, { approval: { defaultMode: 'nonsense' } })).toEqual({ mode: 'manual', source: 'default' });
    expect(startupApprovalMode({ approvalMode: 'manual' }, { approval: { defaultMode: 'auto' } })).toEqual({ mode: 'manual', source: 'flag' });
    expect(startupApprovalMode({ auto: true }, { approval: { defaultMode: 'manual' } })).toEqual({ mode: 'auto', source: 'flag' });
  });
});

interface Seen { cmd?: string; opts?: Record<string, unknown>; root?: Record<string, unknown>; mode?: string }

/** The root flags + hooks of src/index.ts, with `mission start` declaring the same flags. */
function makeProgram() {
  let args: string[] = [];
  const seen: Seen = {};
  const program = new Command().name('qodex').exitOverride();
  const record = (name: string) => (...a: any[]) => {
    const cmd = a[a.length - 1] as Command;
    seen.cmd = name;
    seen.opts = { ...cmd.opts() };
    seen.root = { ...program.opts() };
    if (name === 'root') {
      const o = program.opts() as { auto?: boolean; approvalMode?: string; yes?: boolean };
      setApprovalMode(startupApprovalMode(o, { approval: { defaultMode: 'manual' } }).mode);
    }
    seen.mode = getApprovalMode();
  };
  program
    .argument('[prompt...]')
    .option('-p, --print <prompt>')
    .option('--json')
    .option('-y, --yes')
    .option('--auto')
    .option('--approval-mode <mode>')
    .option('-m, --model <id>')
    .hook('preAction', (root, action) => { handBackRootFlags(root, action, args); })
    .hook('preAction', (root, action) => {
      const o = root.opts() as { auto?: boolean; approvalMode?: string; yes?: boolean };
      const mode = approvalModeFromFlags({ auto: o.auto, approvalMode: o.approvalMode, yes: action === root ? o.yes : undefined });
      if (mode) setApprovalMode(mode);
    })
    .action(record('root'));
  const mission = program.command('mission');
  mission.command('start <goal>')
    .option('-y, --yes')
    .option('--auto')
    .option('--approval-mode <mode>')
    .option('--model <id>')
    .action(record('mission start'));
  program.command('browser').command('open [url]').option('-y, --yes').action(record('browser open'));
  const run = async (...a: string[]): Promise<Seen> => {
    args = a;
    setApprovalMode('manual');
    for (const k of Object.keys(seen)) delete (seen as any)[k];
    await program.parseAsync(a, { from: 'user' });
    return seen;
  };
  return run;
}

describe('root program flags', () => {
  it('`qodex -p "…" --yes` stays a headless run in auto mode', async () => {
    const s = await makeProgram()('-p', 'fix the tests', '--yes');
    expect(s.cmd).toBe('root');
    expect(s.root).toMatchObject({ print: 'fix the tests', yes: true });
    expect(s.mode).toBe('auto');
  });

  it('`qodex --auto` (TUI) and `qodex -p … --auto` start in auto; --approval-mode picks any mode', async () => {
    expect((await makeProgram()('--auto')).mode).toBe('auto');
    expect((await makeProgram()('-p', 'x', '--auto')).mode).toBe('auto');
    expect((await makeProgram()('--approval-mode', 'edits')).mode).toBe('edits');
    expect((await makeProgram()('--approval-mode=auto', 'do', 'it')).mode).toBe('auto');
    expect((await makeProgram()('do', 'it')).mode).toBe('manual');
  });

  it('a bad --approval-mode fails the command', async () => {
    await expect(makeProgram()('--approval-mode', 'yolo-ish')).rejects.toThrow(/manual, edits or auto/);
  });

  it('`mission start <goal> --auto` / `--approval-mode auto` go to the mission (root forgets them)', async () => {
    let s = await makeProgram()('mission', 'start', 'ship it', '--auto');
    expect(s.cmd).toBe('mission start');
    expect(s.opts).toMatchObject({ auto: true });
    expect(s.root?.auto).toBeUndefined();
    s = await makeProgram()('mission', 'start', 'ship it', '--approval-mode', 'auto');
    expect(s.opts).toMatchObject({ approvalMode: 'auto' });
    expect(s.root?.approvalMode).toBeUndefined();
  });

  it('`qodex --auto mission start …` (before the subcommand) sets the session mode the mission defaults to', async () => {
    const s = await makeProgram()('--auto', 'mission', 'start', 'ship it');
    expect(s.cmd).toBe('mission start');
    expect(s.mode).toBe('auto');
  });

  it('-y written before an unrelated subcommand does not switch the process into auto', async () => {
    const s = await makeProgram()('-y', 'browser', 'open');
    expect(s.cmd).toBe('browser open');
    expect(s.mode).toBe('manual');
    const t = await makeProgram()('browser', 'open', '-y');
    expect(t.opts).toMatchObject({ yes: true });
    expect(t.mode).toBe('manual');
  });
});
