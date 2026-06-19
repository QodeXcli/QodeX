import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseSpec, renderTemplate, loadCustomCommands } from '../src/cli/custom-commands.js';

describe('Custom commands — parseSpec', () => {
  it('extracts every supported frontmatter field', () => {
    const raw =
      '---\n' +
      'description: Fix lint\n' +
      'argument-hint: <file-path>\n' +
      'model: claude-sonnet-4\n' +
      'mode: normal\n' +
      'allowed-tools:\n' +
      '  - read_file\n' +
      '  - edit_file\n' +
      '  - bash\n' +
      '---\n' +
      'Body content here. Args: {{ARGUMENTS}}\n';
    const s = parseSpec(raw, 'fix', '/x/fix.md', 'project');
    expect(s.description).toBe('Fix lint');
    expect(s.argumentHint).toBe('<file-path>');
    expect(s.model).toBe('claude-sonnet-4');
    expect(s.mode).toBe('normal');
    expect(s.allowedTools).toEqual(['read_file', 'edit_file', 'bash']);
    expect(s.template).toContain('Body content here');
  });

  it('accepts inline-array allowed-tools', () => {
    const raw =
      '---\n' +
      'allowed-tools: [read_file, edit_file, "bash"]\n' +
      '---\n' +
      'body';
    const s = parseSpec(raw, 'x', '/p/x.md', 'project');
    expect(s.allowedTools).toEqual(['read_file', 'edit_file', 'bash']);
  });

  it('accepts argument-hint with snake_case alias argument_hint', () => {
    const raw =
      '---\n' +
      'argument_hint: <foo>\n' +
      '---\n' +
      'body';
    const s = parseSpec(raw, 'x', '/p/x.md', 'project');
    expect(s.argumentHint).toBe('<foo>');
  });

  it('strips quotes from string values', () => {
    const raw =
      '---\n' +
      'description: "Fix lint and re-run"\n' +
      "model: 'gpt-5'\n" +
      '---\n' +
      'body';
    const s = parseSpec(raw, 'x', '/p/x.md', 'project');
    expect(s.description).toBe('Fix lint and re-run');
    expect(s.model).toBe('gpt-5');
  });

  it('ignores unknown frontmatter keys without throwing', () => {
    const raw =
      '---\n' +
      'description: ok\n' +
      'something_random: whatever\n' +
      'nested-list:\n' +
      '  - a\n' +
      '  - b\n' +
      '---\n' +
      'body';
    const s = parseSpec(raw, 'x', '/p/x.md', 'project');
    expect(s.description).toBe('ok');
    expect(s.template).toBe('body');
  });

  it('treats a file with no frontmatter as a pure template', () => {
    const raw = 'Just a plain prompt body, no frontmatter.';
    const s = parseSpec(raw, 'plain', '/p/plain.md', 'user');
    expect(s.description).toBeUndefined();
    expect(s.template).toBe('Just a plain prompt body, no frontmatter.');
  });

  it('rejects invalid mode values silently', () => {
    const raw =
      '---\n' +
      'mode: subagent\n' +   // not in our whitelist
      '---\n' +
      'body';
    const s = parseSpec(raw, 'x', '/p/x.md', 'project');
    expect(s.mode).toBeUndefined();
  });
});

describe('Custom commands — renderTemplate', () => {
  const ctx = { cwd: '/work' };

  it('substitutes {{ARGUMENTS}} with the entire arg string', () => {
    expect(renderTemplate('Fix `{{ARGUMENTS}}` please', 'src/app.ts --strict', ctx))
      .toBe('Fix `src/app.ts --strict` please');
  });

  it('substitutes positional {{ARG:0}} {{ARG:1}} ...', () => {
    expect(renderTemplate('{{ARG:0}} → {{ARG:1}} (cwd={{CWD}})', 'src/a.ts src/b.ts', ctx))
      .toBe('src/a.ts → src/b.ts (cwd=/work)');
  });

  it('out-of-range positional args render as empty string', () => {
    expect(renderTemplate('first={{ARG:0}} third={{ARG:2}}', 'only-one', ctx))
      .toBe('first=only-one third=');
  });

  it('substitutes {{DATE}} as YYYY-MM-DD', () => {
    const result = renderTemplate('Today is {{DATE}}.', '', ctx);
    expect(result).toMatch(/^Today is \d{4}-\d{2}-\d{2}\.$/);
  });

  it('handles whitespace inside braces', () => {
    expect(renderTemplate('{{  ARGUMENTS  }}', 'x y', ctx)).toBe('x y');
  });
});

describe('Custom commands — discovery & precedence', () => {
  let tmpHome: string;
  let tmpProject: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-home-'));
    tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-proj-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    await fs.mkdir(path.join(tmpHome, '.qodex', 'commands'), { recursive: true });
    await fs.mkdir(path.join(tmpProject, '.qodex', 'commands'), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpProject, { recursive: true, force: true });
  });

  it('discovers user-global commands', async () => {
    await fs.writeFile(
      path.join(tmpHome, '.qodex', 'commands', 'greet.md'),
      '---\ndescription: say hi\n---\nHello {{ARGUMENTS}}',
    );
    const cmds = await loadCustomCommands(tmpProject);
    expect(cmds.get('greet')?.origin).toBe('user');
    expect(cmds.get('greet')?.description).toBe('say hi');
  });

  it('discovers project-local commands', async () => {
    await fs.writeFile(
      path.join(tmpProject, '.qodex', 'commands', 'deploy.md'),
      '---\ndescription: ship it\n---\nDeploy {{ARGUMENTS}}',
    );
    const cmds = await loadCustomCommands(tmpProject);
    expect(cmds.get('deploy')?.origin).toBe('project');
  });

  it('project commands SHADOW user commands of the same name', async () => {
    await fs.writeFile(
      path.join(tmpHome, '.qodex', 'commands', 'review.md'),
      '---\ndescription: user version\n---\nUser body',
    );
    await fs.writeFile(
      path.join(tmpProject, '.qodex', 'commands', 'review.md'),
      '---\ndescription: project version\n---\nProject body',
    );
    const cmds = await loadCustomCommands(tmpProject);
    expect(cmds.get('review')?.origin).toBe('project');
    expect(cmds.get('review')?.description).toBe('project version');
    expect(cmds.get('review')?.template).toBe('Project body');
  });

  it('skips files with invalid command names (must match /^[a-zA-Z][\\w-]*$/)', async () => {
    await fs.writeFile(path.join(tmpProject, '.qodex', 'commands', '1bad.md'), 'body');
    await fs.writeFile(path.join(tmpProject, '.qodex', 'commands', 'has space.md'), 'body');
    await fs.writeFile(path.join(tmpProject, '.qodex', 'commands', 'good-name.md'), 'body');
    const cmds = await loadCustomCommands(tmpProject);
    expect(cmds.has('1bad')).toBe(false);
    expect(cmds.has('has space')).toBe(false);
    expect(cmds.has('good-name')).toBe(true);
  });

  it('returns empty map when no commands directories exist', async () => {
    const cleanProj = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-empty-'));
    try {
      const cmds = await loadCustomCommands(cleanProj);
      // Could still have user-global entries from beforeEach setup, but the empty user dir
      // means nothing should be there either
      const userEntries = [...cmds.values()].filter(s => s.origin === 'user');
      const projEntries = [...cmds.values()].filter(s => s.origin === 'project');
      expect(userEntries).toHaveLength(0);
      expect(projEntries).toHaveLength(0);
    } finally {
      await fs.rm(cleanProj, { recursive: true, force: true });
    }
  });
});
