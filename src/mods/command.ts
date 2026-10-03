/**
 * Mods from the command line and the slash prompt.
 *
 *   qodex mod list                 every mod QodeX can see, and why one does not load
 *   qodex mod new <name>           scaffold ~/.qodex/mods/<name>/ (mod.json + register.js)
 *   qodex mod validate <dir>       load it in a dry engine: events, commands, tools, $ calls, errors
 *   qodex mod test <dir>           run <dir>/**\/*.test.(ts|mts|js|mjs) with the test kit
 *   qodex mod enable|disable <name>
 *   qodex mod trust|untrust <name> project mods (<cwd>/.qodex/mods) load only once trusted
 *   qodex mod path [name]          where user mods live / where a mod is
 *
 *   /mods [enable|disable|trust|untrust <name>]   the same, inside a session (applies now)
 *   /reload-mods                                   reload every mod from disk
 *
 * Mods are code that runs with your permissions: trust a project mod only after reading it.
 */
import { Command } from 'commander';
import { promises as fs } from 'fs';
import * as path from 'path';
import { listModCommands } from './command-registry.js';
import { discoverMods, hashModDir, readModManifest, readModsState, setModEnabled, trustModDir, untrustModDir, type DiscoveredMod } from './loader.js';
import { projectModsDir, userModsDir } from './paths.js';
import { getModsRuntime } from './runtime.js';
import { MOD_LIMITS, type ModInfo } from './types.js';

// ── listing ──────────────────────────────────────────────────────────────────

function stateWord(i: ModInfo): string {
  if (i.error?.startsWith('shadowed')) return 'shadowed';
  if (i.error && !i.loaded) return 'error';
  if (!i.enabled) return 'off';
  if (i.scope === 'project' && i.trustState === 'changed') return 'changed — re-trust';
  if (i.scope === 'project' && !i.trusted) return 'untrusted';
  return i.loaded ? 'on' : 'on (not loaded)';
}

function icon(i: ModInfo): string {
  if (i.loaded) return '●';
  if (i.error) return '✗';
  if (i.scope === 'project' && !i.trusted && i.enabled) return '⚠';
  return '○';
}

/** Lines describing `infos` (for /mods and `qodex mod list`). PURE. */
export function formatModList(infos: ModInfo[], opts: { live: boolean }): string {
  if (infos.length === 0) {
    return [
      'No mods.',
      `  Write one in ${userModsDir()}/<name>/ (mod.json + register.js) — \`qodex mod new <name>\` scaffolds it,`,
      '  or /mod new <what it should do> and QodeX writes it for you.',
    ].join('\n');
  }
  const lines = [`Mods (${infos.filter(i => i.loaded).length} loaded):`];
  for (const i of infos) {
    const where = i.fromModDir ? '--mod-dir' : i.scope;
    lines.push(`  ${icon(i)} ${i.name}  [${where}] ${stateWord(i)}${i.description ? ` — ${i.description}` : ''}`);
    if (opts.live && i.loaded) {
      const parts = [
        i.events.length ? `events: ${i.events.join(', ')}` : '',
        i.commands.length ? `commands: ${i.commands.map(c => '/' + c).join(' ')}` : '',
        i.tools.length ? `tools: ${i.tools.join(', ')}` : '',
      ].filter(Boolean);
      if (parts.length) lines.push(`      ${parts.join(' · ')}`);
    }
    if (i.error && !i.loaded) lines.push(`      ${i.error}`);
    if (i.scope === 'project' && i.enabled && !i.trusted && !i.error) {
      lines.push(`      project code — read ${i.dir} first, then: /mods trust ${i.name}`);
    }
    for (const w of i.warnings ?? []) lines.push(`      warning: ${w}`);
  }
  lines.push('', '/mods enable|disable|trust|untrust <name> · /reload-mods · mods run with your permissions');
  return lines.join('\n');
}

/** The /help section listing mod commands ('' when there are none). */
export function modCommandsHelp(): string {
  const cmds = listModCommands();
  if (cmds.length === 0) return '';
  const rows = cmds.map(c => {
    const head = `/${c.name}${c.argumentHint ? ' ' + c.argumentHint : ''}`;
    return `    ${head.padEnd(30)} ${c.description || '(no description)'}  [${c.plugin}]`;
  });
  return `\n\n  Mod commands\n${rows.join('\n')}`;
}

// ── actions shared by /mods and `qodex mod` ──────────────────────────────────

async function findMod(name: string, cwd: string): Promise<DiscoveredMod | undefined> {
  const all = await discoverMods({ cwd, extraDirs: [] });
  return all.find(d => d.info.name === name && !d.info.error?.startsWith('shadowed')) ?? all.find(d => d.info.name === name);
}

export async function enableMod(name: string, cwd: string, enabled: boolean): Promise<string> {
  const d = await findMod(name, cwd);
  const rt = getModsRuntime();
  const known = d || (rt?.list().some(i => i.name === name) ?? false);
  if (!known) return `No mod named "${name}". \`/mods\` lists them.`;
  await setModEnabled(name, enabled);
  if (!rt) return `${name} ${enabled ? 'enabled' : 'disabled'} (takes effect in the next session).`;
  if (!enabled) {
    const was = rt.unload(name);
    return `${name} disabled${was ? ' and unloaded' : ''}.`;
  }
  const r = await rt.loadByName(name);
  return r.ok ? `${name} enabled and loaded.` : `${name} enabled, but it did not load: ${r.error}`;
}

export async function trustMod(name: string, cwd: string): Promise<string> {
  const dir = path.join(projectModsDir(cwd), name);
  const m = await readModManifest(dir);
  if (!m.ok) {
    const d = await findMod(name, cwd);
    if (d && d.info.scope !== 'project') return `${name} is a ${d.info.scope} mod — only project mods (${projectModsDir(cwd)}) need trust.`;
    return `No project mod "${name}" in ${projectModsDir(cwd)}${m.error ? ` (${m.error})` : ''}.`;
  }
  let hash: string;
  try {
    hash = await hashModDir(dir, { strict: true });
  } catch (e: any) {
    return `Cannot trust ${m.manifest.name}: ${e?.message ?? e}`;
  }
  await trustModDir(dir, m.manifest.name, hash);
  const rt = getModsRuntime();
  const lines = [`Trusted ${m.manifest.name} (${dir}). It loads from now on; any change to its files needs a new trust.`];
  if (rt) {
    const r = await rt.loadByName(m.manifest.name);
    lines.push(r.ok ? 'Loaded.' : `It did not load: ${r.error}`);
  }
  return lines.join('\n');
}

export async function untrustMod(name: string, cwd: string): Promise<string> {
  const dir = path.join(projectModsDir(cwd), name);
  const removed = await untrustModDir(dir);
  getModsRuntime()?.unload(name);
  return removed ? `${name} is no longer trusted (unloaded).` : `${name} was not trusted.`;
}

/** /mods [enable|disable|trust|untrust <name>] */
export async function handleModsSlash(args: string[], cwd: string): Promise<string> {
  const sub = (args[0] ?? '').toLowerCase();
  const name = args[1] ?? '';
  const needName = (verb: string) => `Usage: /mods ${verb} <name>`;
  switch (sub) {
    case '':
    case 'list': {
      const rt = getModsRuntime();
      if (rt) return formatModList(rt.list(), { live: true });
      return formatModList((await discoverMods({ cwd })).map(d => d.info), { live: false });
    }
    case 'enable':
    case 'on':
      return name ? enableMod(name, cwd, true) : needName('enable');
    case 'disable':
    case 'off':
      return name ? enableMod(name, cwd, false) : needName('disable');
    case 'trust':
      return name ? trustMod(name, cwd) : needName('trust');
    case 'untrust':
      return name ? untrustMod(name, cwd) : needName('untrust');
    default:
      return 'Usage: /mods [enable|disable|trust|untrust <name>]';
  }
}

/** /reload-mods */
export async function reloadModsSlash(): Promise<string> {
  const rt = getModsRuntime();
  if (!rt) return 'Mods are not running in this session (QODEX_NO_MODS=1?).';
  const loaded = await rt.reload();
  const failed = rt.list().filter(i => i.error && !i.loaded && i.enabled && !i.error.startsWith('shadowed'));
  const lines = [`Reloaded ${loaded.length} mod${loaded.length === 1 ? '' : 's'}${loaded.length ? `: ${loaded.join(', ')}` : ''}.`];
  for (const f of failed) lines.push(`  ✗ ${f.name}: ${f.error}`);
  return lines.join('\n');
}

// ── validate ─────────────────────────────────────────────────────────────────

export interface ModValidation {
  ok: boolean;
  dir: string;
  name?: string;
  layout?: 'qodex' | 'claude';
  entry?: string;
  events: string[];
  commands: string[];
  tools: string[];
  /** $ calls found in the source, without the `$.` (e.g. fs.read). */
  apiCalls: string[];
  errors: string[];
  warnings: string[];
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(m?[jt]s)$/.test(e.name) && !/\.test\.m?[jt]s$/.test(e.name)) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

/**
 * Load a mod in a dry engine (nothing reaches the machine: fs / process / http / model
 * calls are refused), fire session.start, and report what it uses and what went wrong.
 */
export async function validateModDir(dirArg: string): Promise<ModValidation> {
  const dir = path.resolve(dirArg);
  const v: ModValidation = { ok: false, dir, events: [], commands: [], tools: [], apiCalls: [], errors: [], warnings: [] };
  const m = await readModManifest(dir);
  if (!m.ok) { v.errors.push(m.error); return v; }
  v.name = m.manifest.name;
  v.layout = m.layout;
  v.entry = path.relative(dir, m.entry);
  const calls = new Set<string>();
  for (const f of await sourceFiles(dir)) {
    try {
      const src = await fs.readFile(f, 'utf-8');
      for (const x of src.matchAll(/\$\.(\w+)\.(\w+)\s*\(/g)) calls.add(`${x[1]}.${x[2]}`);
    } catch { /* unreadable file */ }
  }
  v.apiCalls = [...calls].sort();
  const { createTestHarness } = await import('./testing.js');
  const h = createTestHarness({ dir, hookMs: 5_000 });
  try {
    await h.load();
  } catch (e: any) {
    v.errors.push(`load: ${e?.message ?? e}`);
    h.dispose();
    return v;
  }
  try {
    await h.$.session.start();
  } catch (e: any) {
    v.errors.push(`session.start: ${e?.message ?? e}`);
  }
  v.events = h.engine.eventsOf(h.modName);
  v.warnings.push(...h.engine.warningsOf(h.modName));
  if (v.events.length === 0) v.warnings.push('register() added no hooks — the mod does nothing');
  v.commands = [...h.commands.keys()].map(n => '/' + n);
  v.tools = [...h.tools.keys()];
  for (const e of h.ui.errors) {
    // A refused command name or a broken session.start is an error; a $ call the dry engine
    // refused (fs / process / http / model) only means it needs the real QodeX.
    if (/no implementation for/.test(e)) v.warnings.push(`${e} (expected in a dry run)`);
    else v.errors.push(e);
  }
  h.dispose();
  v.ok = v.errors.length === 0;
  return v;
}

export function formatValidation(v: ModValidation): string {
  const lines = [`${v.ok ? '✓' : '✗'} ${v.name ?? path.basename(v.dir)}  (${v.dir})`];
  if (v.layout) lines.push(`  layout: ${v.layout === 'claude' ? 'Claude Code plugin (.claude-plugin + hooks/hooks.json)' : 'mod.json'} · entry: ${v.entry}`);
  if (v.events.length) lines.push(`  events: ${v.events.join(', ')}`);
  if (v.commands.length) lines.push(`  commands: ${v.commands.join(' ')}`);
  if (v.tools.length) lines.push(`  tools: ${v.tools.join(', ')}`);
  if (v.apiCalls.length) lines.push(`  $ calls: ${v.apiCalls.join(', ')}`);
  for (const e of v.errors) lines.push(`  error: ${e}`);
  for (const w of v.warnings) lines.push(`  warning: ${w}`);
  return lines.join('\n');
}

// ── scaffold ─────────────────────────────────────────────────────────────────

const SAMPLE_REGISTER = (name: string) => `// ${name} — a QodeX mod. Hooks run inside QodeX with your permissions.
// Events, the $ API and limits: docs/MODS.md. Check it: qodex mod validate <this dir>.

export function register(on, options) {
  let toolCalls = 0;

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: '${name}', description: 'Show what ${name} has seen' });
    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    toolCalls += 1;
    $.ui.status(\`\${toolCalls} tool call\${toolCalls === 1 ? '' : 's'} this session\`);
    return next(e);
  });

  on('command.run', { command: '${name}' }, async () => {
    return { text: \`${name}: \${toolCalls} tool call\${toolCalls === 1 ? '' : 's'} so far.\` };
  });
}
`;

const SAMPLE_TEST = (name: string) => `import { test, expect } from 'qodex/testing';

test('/${name} counts tool calls', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }));
  await $.session.start();
  await $.tool.call({ tool: 'shell', command: 'ls' });
  const answer = await $.command.run({ command: '${name}', args: '' });
  expect(answer.text).toBe('${name}: 1 tool call so far.');
});
`;

/** Write ~/.qodex/mods/<name>/ with mod.json, register.js and a test. Never overwrites. */
export async function scaffoldMod(name: string, opts: { root?: string; description?: string } = {}): Promise<{ ok: boolean; dir: string; message: string }> {
  if (!MOD_LIMITS.nameRe.test(name)) return { ok: false, dir: '', message: `"${name}" is not a mod name (letters, digits, _ and -, up to 64).` };
  const dir = path.join(opts.root ?? userModsDir(), name);
  try {
    await fs.stat(dir);
    return { ok: false, dir, message: `${dir} already exists — pick another name or edit it.` };
  } catch { /* free */ }
  await fs.mkdir(dir, { recursive: true });
  const manifest = { name, description: opts.description ?? `${name} (edit me)`, version: '0.1.0' };
  await fs.writeFile(path.join(dir, 'mod.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  await fs.writeFile(path.join(dir, 'register.js'), SAMPLE_REGISTER(name), 'utf-8');
  await fs.writeFile(path.join(dir, `${name}.test.js`), SAMPLE_TEST(name), 'utf-8');
  return {
    ok: true,
    dir,
    message: `Created ${dir}\n  mod.json, register.js, ${name}.test.js\nNext: qodex mod validate ${dir} · qodex mod test ${dir} · /reload-mods in a session`,
  };
}

// ── qodex mod … ──────────────────────────────────────────────────────────────

export function buildModCommand(io: { out: (l: string) => void; err: (l: string) => void } = { out: l => console.log(l), err: l => console.error(l) }): Command {
  const cmd = new Command('mod').description('Mods: plugins of hooks that change how QodeX itself works (list, new, validate, test, enable, trust)');

  cmd.command('list').description('List every mod QodeX can see and why one does not load')
    .option('--json', 'Print JSON')
    .action(async (o: { json?: boolean }) => {
      const infos = (await discoverMods({ cwd: process.cwd() })).map(d => d.info);
      io.out(o.json ? JSON.stringify(infos, null, 2) : formatModList(infos, { live: false }));
    });

  cmd.command('new <name>').description(`Scaffold a mod in ${userModsDir()}/<name>`)
    .option('-d, --description <text>', 'One line for mod.json')
    .action(async (name: string, o: { description?: string }) => {
      const r = await scaffoldMod(name, { description: o.description });
      (r.ok ? io.out : io.err)(r.message);
      if (!r.ok) process.exitCode = 1;
    });

  cmd.command('validate <dir>').description('Load a mod in a dry engine and report events, commands, tools, $ calls and errors')
    .option('--json', 'Print JSON')
    .action(async (dir: string, o: { json?: boolean }) => {
      const v = await validateModDir(dir);
      io.out(o.json ? JSON.stringify(v, null, 2) : formatValidation(v));
      if (!v.ok) process.exitCode = 1;
    });

  cmd.command('test [dir]').description('Run the *.test.(ts|mts|js|mjs) files of a mod with the test kit')
    .action(async (dir?: string) => {
      const { runModTests } = await import('./testing.js');
      const r = await runModTests(dir ?? process.cwd(), { out: io.out });
      if (r.failed > 0 || r.results.length === 0) process.exitCode = 1;
    });

  for (const [verb, on] of [['enable', true], ['disable', false]] as const) {
    cmd.command(`${verb} <name>`).description(`${verb === 'enable' ? 'Switch a mod on' : 'Switch a mod off'} (~/.qodex/mods.json)`)
      .action(async (name: string) => { io.out(await enableMod(name, process.cwd(), on)); });
  }

  cmd.command('trust <name>').description('Let a project mod (<cwd>/.qodex/mods/<name>) load — read its code first')
    .action(async (name: string) => { io.out(await trustMod(name, process.cwd())); });

  cmd.command('untrust <name>').description('Stop a project mod from loading')
    .action(async (name: string) => { io.out(await untrustMod(name, process.cwd())); });

  cmd.command('path [name]').description('Print the user mods dir, or where a mod is')
    .action(async (name?: string) => {
      if (!name) { io.out(userModsDir()); return; }
      const d = await findMod(name, process.cwd());
      if (!d) { io.err(`No mod named "${name}".`); process.exitCode = 1; return; }
      io.out(d.info.dir);
    });

  return cmd;
}

/** Current state file, for `qodex mod list --json` consumers and tests. */
export { readModsState };
