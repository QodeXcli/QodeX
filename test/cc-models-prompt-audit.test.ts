import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  runPromptAudit, calmLine, parseModelEdits, collectPromptSurface,
  PROMPT_AUDIT_REPORT, PROMPT_AUDIT_PATCH, type AuditFinding,
} from '../src/checkup/prompt-audit.js';
import { describeChecks, CHECKUP_CHECKS } from '../src/checkup/index.js';
import { handleSlashCommand } from '../src/cli/slash-commands.js';
import { SLASH_CATALOG } from '../src/cli/slash-catalog.js';

let root: string;
let cwd: string;
let home: string;

async function write(rel: string, text: string, base = cwd): Promise<string> {
  const p = path.join(base, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
  return p;
}

/** sha256 of every file under a directory (outputs excluded) — proves the audit wrote nothing there. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string): Promise<void> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name !== PROMPT_AUDIT_REPORT && e.name !== PROMPT_AUDIT_PATCH) {
        out[path.relative(dir, p)] = createHash('sha256').update(await fs.readFile(p)).digest('hex');
      }
    }
  }
  await walk(dir);
  return out;
}

const known = new Set(['read_file', 'write_file', 'shell', 'grep', 'glob', 'edit_text']);
const isKnownTool = (n: string) => known.has(n);
const has = (fs_: AuditFinding[], rule: string, file: string, line?: number) =>
  fs_.some(f => f.rule === rule && f.file === file && (line === undefined || f.line === line));

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-audit-'));
  cwd = path.join(root, 'proj');
  home = path.join(root, 'home');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  await write('src/main.ts', 'export {};\n');
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function seedProject(): Promise<void> {
  await write('QODEX.md', [
    '# Rules',
    '',
    'CRITICAL: You MUST run `npm test` before EVERY commit!!',
    'NEVER edit `src/generated/schema.ts` by hand.',
    'ALWAYS use npm for installs.',
    '- Entry point: `src/main.ts`; the old router was `src/old/router.ts`.',
    '- Reviews use claude-3-5-sonnet-20241022 (or Sonnet 4).',
    'Use the Read tool first, then run /init.',
    '```',
    'NEVER ALWAYS MUST in a code block are ignored, and so is `src/nope/x.ts`',
    '```',
    '',
  ].join('\n'));
  await write('AGENTS.md', '# Agents\nNever use npm; use pnpm.\nKeep commits small and explain the reason for every single change.\n');
  await write('CLAUDE.md', 'Keep commits small and explain the reason for every single change.\n');
  await write('.qodex/skills/reviewer/SKILL.md', [
    '---',
    'name: reviewer',
    'description: Review code',
    'model: claude-sonnet-4-6',
    'allowed-tools:',
    '  - Read',
    '  - read_file',
    '  - Bash(git:*)',
    '  - mcp__github__get_pr',
    '---',
    'See [the guide](./guide.md) and `./missing.md`.',
    '',
  ].join('\n'));
  await write('.qodex/skills/reviewer/guide.md', '# guide\n');
  await write('.qodex/commands/ship.md', '---\ndescription: ship it\n---\nRun /ship-it then /model opus and /review.\n');
  await write('.qodex/mods/hello/mod.json', JSON.stringify({ name: 'hello', description: 'Greets using gpt-4o' }, null, 2) + '\n');
  // User-level file: applies to every project.
  await write('.qodex/QODEX.md', 'Prefer Opus 4.1 for planning.\n', home);
}

describe('prompt-audit — deterministic findings', () => {
  it('finds each class of problem with file:line', async () => {
    await seedProject();
    const r = await runPromptAudit({ cwd, home, noModel: true, isKnownTool, write: false });
    const f = r.findings;
    expect(has(f, 'shouting', 'QODEX.md', 3)).toBe(true);
    expect(has(f, 'shouting', 'QODEX.md', 10)).toBe(false); // fenced code is not prose
    expect(has(f, 'stale-path', 'QODEX.md', 4)).toBe(true);
    expect(f.find(x => x.rule === 'stale-path' && x.evidence === 'src/old/router.ts')?.line).toBe(6);
    expect(f.some(x => x.rule === 'stale-path' && x.evidence === 'src/main.ts')).toBe(false);
    expect(f.some(x => x.evidence === 'src/nope/x.ts')).toBe(false);
    expect(has(f, 'stale-model', 'QODEX.md', 7)).toBe(true);
    expect(f.some(x => x.rule === 'stale-model' && x.evidence === 'Sonnet 4')).toBe(true);
    expect(has(f, 'unknown-tool', 'QODEX.md', 8)).toBe(true);
    expect(f.some(x => x.rule === 'unknown-command' && x.evidence === '/init')).toBe(true);
    expect(has(f, 'contradiction', 'QODEX.md', 5)).toBe(true);
    expect(has(f, 'contradiction', 'AGENTS.md', 2)).toBe(true);
    expect(has(f, 'duplicate', 'CLAUDE.md', 1)).toBe(true);
    // Skill: pinned stale model (high), Claude Code tool name in allowed-tools, stale ./ path.
    const skill = '.qodex/skills/reviewer/SKILL.md';
    expect(f.find(x => x.file === skill && x.rule === 'stale-model')?.severity).toBe('high');
    expect(f.some(x => x.file === skill && x.rule === 'unknown-tool' && x.evidence === 'Read')).toBe(true);
    // Claude Code's `Bash(git:*)` form maps to shell; MCP tool names are dynamic and skipped.
    expect(f.find(x => x.file === skill && x.rule === 'unknown-tool' && x.evidence === 'Bash(git:*)')?.suggestion).toContain('shell');
    expect(f.some(x => x.file === skill && x.rule === 'unknown-tool' && /mcp__/.test(x.evidence))).toBe(false);
    expect(f.some(x => x.file === skill && x.rule === 'stale-path' && x.evidence === './missing.md')).toBe(true);
    expect(f.some(x => x.file === skill && x.evidence === './guide.md')).toBe(false);
    // Custom command name and catalog commands are known; unknown ones are flagged.
    const cmd = '.qodex/commands/ship.md';
    expect(f.some(x => x.file === cmd && x.evidence === '/ship-it')).toBe(true);
    expect(f.some(x => x.file === cmd && x.evidence === '/model')).toBe(false);
    // Mod manifest and user-level file are on the surface too.
    expect(has(f, 'stale-model', '.qodex/mods/hello/mod.json')).toBe(true);
    expect(f.some(x => x.file === '~/.qodex/QODEX.md' && x.rule === 'stale-model')).toBe(true);
  });

  it('flags oversized always-loaded files', async () => {
    await write('AI.md', 'Describe the domain model carefully. '.repeat(2500));
    const r = await runPromptAudit({ cwd, home, noModel: true, write: false });
    const big = r.findings.find(x => x.rule === 'oversized' && x.file === 'AI.md');
    expect(big).toBeDefined();
    expect(['medium', 'high']).toContain(big!.severity);
  });

  it('a clean surface yields no findings and an empty patch', async () => {
    await write('QODEX.md', '# Rules\nRun the tests in `src/main.ts` before committing; CI does not.\n');
    const r = await runPromptAudit({ cwd, home, noModel: true, write: true });
    expect(r.findings).toEqual([]);
    expect(r.report).toContain('clean');
    expect(await fs.readFile(path.join(cwd, PROMPT_AUDIT_PATCH), 'utf8')).toMatch(/no edits proposed/);
  });

  it('inventories project and ~/.qodex instruction files, skills, commands and mods', async () => {
    await seedProject();
    const files = (await collectPromptSurface(cwd, home)).map(f => `${f.kind}:${f.display}`);
    expect(files).toEqual(expect.arrayContaining([
      'instructions:QODEX.md', 'instructions:AGENTS.md', 'instructions:CLAUDE.md', 'instructions:~/.qodex/QODEX.md',
      'skill:.qodex/skills/reviewer/SKILL.md', 'command:.qodex/commands/ship.md', 'mod:.qodex/mods/hello/mod.json',
    ]));
  });
});

describe('prompt-audit — outputs and the never-modify rule', () => {
  it('writes PROMPT_AUDIT.md + a patch that applies, and changes no audited file', async () => {
    await seedProject();
    const beforeProj = await snapshot(cwd);
    const beforeHome = await snapshot(home);
    const r = await runPromptAudit({ cwd, home, noModel: true, isKnownTool });
    expect(await snapshot(cwd)).toEqual(beforeProj);
    expect(await snapshot(home)).toEqual(beforeHome);

    const report = await fs.readFile(path.join(cwd, PROMPT_AUDIT_REPORT), 'utf8');
    expect(report).toContain('Nothing was changed');
    expect(report).toMatch(/`QODEX\.md:3`/);
    expect(report).toContain('skipped (--no-model)');
    const patch = await fs.readFile(path.join(cwd, PROMPT_AUDIT_PATCH), 'utf8');
    expect(patch).toContain('--- a/QODEX.md');
    expect(patch).toContain('+You must run `npm test` before EVERY commit.');
    expect(patch).toContain('claude-sonnet-5-5');
    expect(patch).toContain('+  - read_file'); // Read → read_file in the skill allow-list
    expect(r.patchedFiles).toBeGreaterThan(0);

    // The project hunks apply cleanly (the user-level file is outside the project: patch -p0).
    const projectOnly = patch.split(/(?=^--- )/m).filter(c => c.startsWith('--- a/')).join('');
    await fs.writeFile(path.join(root, 'project.patch'), projectOnly);
    execFileSync('git', ['apply', '--check', path.join(root, 'project.patch')], { cwd });
  });

  it('the model pass only adds exact-quote edits on untouched lines and never writes the files', async () => {
    await seedProject();
    const before = await snapshot(cwd);
    const calls: string[] = [];
    const model = {
      name: 'fake/model',
      complete: async (_s: string, user: string) => {
        calls.push(user);
        if (!user.startsWith('File: AGENTS.md')) return '{"edits":[]}';
        return 'Here you go:\n```json\n' + JSON.stringify({ edits: [
          { line: 3, from: 'Keep commits small and explain the reason for every single change.', to: 'Keep commits small; say why in the message.', why: 'shorter' },
          { line: 2, from: 'not what the line says', to: 'x', why: 'bad quote' },
          { line: 99, from: '', to: 'x', why: 'out of range' },
        ] }) + '\n```';
      },
    };
    const r = await runPromptAudit({ cwd, home, model, isKnownTool, maxModelFiles: 10 });
    expect(r.modelUsed).toBe('fake/model');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.includes('<file>'))).toBe(true);
    const rewrites = r.findings.filter(f => f.rule === 'model-rewrite');
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toMatchObject({ file: 'AGENTS.md', line: 3, inPatch: true });
    expect(r.patch).toContain('+Keep commits small; say why in the message.');
    expect(await snapshot(cwd)).toEqual(before);
  });

  it('a model edit cannot override a deterministic edit on the same line', async () => {
    await write('QODEX.md', 'NEVER do A.\nNEVER do B.\nNEVER do C.\n');
    const model = {
      name: 'fake',
      complete: async () => JSON.stringify({ edits: [{ line: 1, from: 'NEVER do A.', to: 'Do A whenever.', why: 'x' }] }),
    };
    const r = await runPromptAudit({ cwd, home, model, write: false });
    expect(r.patch).toContain('+Never do A.');
    expect(r.patch).not.toContain('Do A whenever');
  });

  it('--no-model never calls the model; a missing model is reported and findings still written', async () => {
    await seedProject();
    let called = false;
    const model = { name: 'x', complete: async () => { called = true; return ''; } };
    const r1 = await runPromptAudit({ cwd, home, noModel: true, model, write: false });
    expect(called).toBe(false);
    expect(r1.modelSkipped).toBe('--no-model');

    const r2 = await runPromptAudit({ cwd, home, modelUnavailableReason: 'no model available' });
    expect(r2.modelSkipped).toBe('no model available');
    expect(r2.findings.length).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(cwd, PROMPT_AUDIT_REPORT), 'utf8')).toContain('skipped (no model available)');
  });

  it('a failing model call is reported, not fatal', async () => {
    await seedProject();
    const model = { name: 'flaky', complete: async () => { throw new Error('503 overloaded'); } };
    const r = await runPromptAudit({ cwd, home, model, write: false });
    expect(r.report).toContain('model call failed');
    expect(r.findings.some(f => f.rule === 'shouting')).toBe(true);
  });
});

describe('prompt-audit helpers', () => {
  it('calmLine lowers the volume and keeps the meaning', () => {
    expect(calmLine('CRITICAL: You MUST run tests!!')).toBe('You must run tests.');
    expect(calmLine('- **IMPORTANT:** ALWAYS lint')).toBe('- Always lint');
    expect(calmLine('NEVER commit secrets.')).toBe('Never commit secrets.');
    expect(calmLine('## IMPORTANT')).toBe('## Important');
    expect(calmLine('Use `MUST_FLAG` here, NEVER elsewhere')).toBe('Use `MUST_FLAG` here, never elsewhere');
  });

  it('parseModelEdits tolerates prose and rejects junk', () => {
    expect(parseModelEdits('nope')).toEqual([]);
    expect(parseModelEdits('{"edits":[{"line":"1","from":"a","to":"b"}]}')).toEqual([]);
    expect(parseModelEdits('ok {"edits":[{"line":2,"from":"a","to":"b","why":"w"}]} done')).toEqual([{ line: 2, from: 'a', to: 'b', why: 'w' }]);
  });
});

describe('/checkup, /doctor prompt-audit', () => {
  it('lists the available checks', async () => {
    const r = await handleSlashCommand('/checkup', 's', cwd);
    expect(r.message).toContain('/checkup prompt-audit [--no-model]');
    expect(describeChecks()).toContain(CHECKUP_CHECKS[0]!.name);
    const d = await handleSlashCommand('/doctor', 's', cwd);
    expect(d.message).toContain('/doctor prompt-audit');
  });

  it('runs the audit without a model and reports where the files went', async () => {
    await write('QODEX.md', 'NEVER do A.\nNEVER do B.\nALWAYS do C.\n');
    const r = await handleSlashCommand('/doctor prompt-audit --no-model', 's', cwd);
    expect(r.handled).toBe(true);
    expect(r.message).toContain('Nothing was changed');
    expect(r.message).toContain(path.join(cwd, PROMPT_AUDIT_REPORT));
    expect(await fs.readFile(path.join(cwd, 'QODEX.md'), 'utf8')).toBe('NEVER do A.\nNEVER do B.\nALWAYS do C.\n');
  });

  it('rejects an unknown check and is in the slash catalog', async () => {
    const r = await handleSlashCommand('/checkup nope', 's', cwd);
    expect(r.message).toContain('Unknown check: nope');
    const names = SLASH_CATALOG.map(c => c.name);
    expect(names).toContain('checkup');
    expect(names).toContain('doctor');
  });
});
