/**
 * handBackRootFlags (src/cli/root-flags.ts): flags the ROOT program swallowed although
 * they were written after a subcommand that declares the same flag go back to that
 * subcommand — matched by the flag as typed — and leave the root. A mini program
 * mirrors src/index.ts: the same root flags and the colliding subcommand options.
 * (test/followup-channels.test.ts drives the real CLI end to end.)
 */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { handBackRootFlags } from '../src/cli/root-flags.js';

interface Seen {
  cmd?: string;
  opts?: Record<string, unknown>;
  globals?: Record<string, unknown>;
  root?: Record<string, unknown>;
  /** What the config-overlay hook (root --profile) saw. */
  overlay?: string;
}

const collect = (v: string, prev: string[]) => [...prev, v];

function makeProgram() {
  let args: string[] = [];
  const seen: Seen = {};
  const program = new Command().name('qodex').exitOverride();
  const record = (name: string) => (...a: any[]) => {
    const cmd = a[a.length - 1] as Command;
    seen.cmd = name;
    seen.opts = { ...cmd.opts() };
    seen.globals = cmd.optsWithGlobals();
    seen.root = { ...program.opts() };
  };
  program
    .argument('[prompt...]')
    .option('-p, --print <prompt>')
    .option('--profile <name>')
    .option('--json')
    .option('-y, --yes')
    .option('--scope <path-prefix>')
    .option('-m, --model <id>')
    .hook('preAction', (root, action) => { handBackRootFlags(root, action, args); })
    .hook('preAction', root => { seen.overlay = (root.opts() as { profile?: string }).profile; })
    .action(record('root'));
  const wf = program.command('workflow');
  wf.command('run <name>')
    .option('-p, --param <name=value>', 'repeatable', collect, [] as string[])
    .option('--dry-run')
    .option('--json')
    .action(record('workflow run'));
  wf.command('list').option('--json').action(record('workflow list'));
  const browser = program.command('browser');
  browser.command('open [url]').option('-p, --profile <name>').option('-y, --yes').action(record('browser open'));
  const schedule = program.command('schedule');
  schedule.command('add').requiredOption('--name <n>').option('--model <id>').option('--mission').action(record('schedule add'));
  program.command('telegram').command('status', { isDefault: true }).option('--json').action(record('telegram status'));
  program.command('mcp').command('serve').option('--scope <scope>').action(record('mcp serve'));
  program.command('skill').command('remove <name>').option('--yes').action(record('skill remove'));
  const run = async (...a: string[]): Promise<Seen> => {
    args = a;
    for (const k of Object.keys(seen)) delete (seen as any)[k];
    await program.parseAsync(a, { from: 'user' });
    return seen;
  };
  return run;
}

describe('handBackRootFlags', () => {
  it('-p after `workflow run` is --param (repeatable), not the root --print', async () => {
    const s = await makeProgram()('workflow', 'run', 'search', '-p', 'query=hello', '-p', 'page=2', '--dry-run');
    expect(s.cmd).toBe('workflow run');
    expect(s.opts).toMatchObject({ param: ['query=hello', 'page=2'], dryRun: true });
    expect(s.root?.print).toBeUndefined();
  });

  it('`browser open -p/--profile <name>` is a browser profile and never the config overlay', async () => {
    for (const a of [['-p', 'work'], ['--profile', 'work'], ['-pwork'], ['--profile=work']]) {
      const s = await makeProgram()('browser', 'open', ...a);
      expect(s.opts?.profile).toBe('work');
      expect(s.globals?.profile).toBe('work');
      expect(s.overlay).toBeUndefined();
      expect(s.root).not.toHaveProperty('profile');
      expect(s.root).not.toHaveProperty('print');
    }
  });

  it('a root flag written BEFORE the subcommand stays the root\'s', async () => {
    const s = await makeProgram()('--profile', 'cloud', 'browser', 'open');
    expect(s.overlay).toBe('cloud');
    expect(s.opts?.profile).toBeUndefined();
    const both = await makeProgram()('--profile', 'cloud', 'browser', 'open', '--profile', 'work');
    expect(both.overlay).toBe('cloud');
    expect(both.opts?.profile).toBe('work');
  });

  it('schedule add --model reaches the subcommand (own opts and optsWithGlobals)', async () => {
    const s = await makeProgram()('schedule', 'add', '--mission', '--model', 'fake:1b', '--name', 'n');
    expect(s.opts).toMatchObject({ mission: true, model: 'fake:1b', name: 'n' });
    expect(s.globals?.model).toBe('fake:1b');
    const eq = await makeProgram()('schedule', 'add', '--name', 'n', '--model=fake:3b');
    expect(eq.opts?.model).toBe('fake:3b');
  });

  it('a spelling the subcommand lacks goes to its option of the same name (-m → --model, -y → --yes)', async () => {
    const s = await makeProgram()('schedule', 'add', '--name', 'n', '-m', 'fake:2b');
    expect(s.opts?.model).toBe('fake:2b');
    expect(s.root).not.toHaveProperty('model');
    const y = await makeProgram()('skill', 'remove', 'x', '-y');
    expect(y.opts?.yes).toBe(true);
    expect(y.root).not.toHaveProperty('yes');
  });

  it('--json after a subcommand (also a default one) is that subcommand\'s', async () => {
    const list = await makeProgram()('workflow', 'list', '--json');
    expect(list.opts?.json).toBe(true);
    expect(list.root).not.toHaveProperty('json');
    const tg = await makeProgram()('telegram', '--json');
    expect(tg.cmd).toBe('telegram status');
    expect(tg.opts?.json).toBe(true);
  });

  it('mcp serve --scope is the exposure scope, not the root path-prefix gate', async () => {
    const s = await makeProgram()('mcp', 'serve', '--scope', 'all');
    expect(s.opts?.scope).toBe('all');
    expect(s.root).not.toHaveProperty('scope');
  });

  it('a root flag the subcommand does not declare stays the root\'s (optsWithGlobals sees it)', async () => {
    const s = await makeProgram()('workflow', 'list', '-m', 'big');
    expect(s.opts).not.toHaveProperty('model');
    expect(s.root?.model).toBe('big');
    expect(s.globals?.model).toBe('big');
  });

  it('a root option VALUE equal to a command name does not move the boundary', async () => {
    const s = await makeProgram()('--profile', 'workflow', 'workflow', 'list', '--json');
    expect(s.cmd).toBe('workflow list');
    expect(s.overlay).toBe('workflow');
    expect(s.opts?.json).toBe(true);
  });

  it('nothing after `--` is handed back', async () => {
    const s = await makeProgram()('workflow', 'run', 'x', '--', '-p', 'a=1');
    expect(s.opts?.param).toEqual([]);
  });
});
