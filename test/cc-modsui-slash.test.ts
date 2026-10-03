/**
 * "QodeX writes the mod": `/mod new <description>` submits a prompt that runs the bundled
 * mod-writing playbook (examples/skills/modsmith), the catalog and /help list it, and the
 * playbook never auto-loads for prompts that are not about mods.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { handleSlashCommand } from '../src/cli/slash-commands.js';
import { SLASH_CATALOG } from '../src/cli/slash-catalog.js';
import { parseSkill } from '../src/skills/loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED = path.resolve(HERE, '..', 'examples', 'skills');
const SKILL_DIR = path.join(BUNDLED, 'modsmith');

describe('/mod new', () => {
  it('without a description shows how to use it', async () => {
    for (const input of ['/mod', '/mod new', '/mod list']) {
      const r = await handleSlashCommand(input, 'sess', process.cwd());
      expect(r.handled).toBe(true);
      expect(r.action).toBeUndefined();
      expect(r.message).toMatch(/^Usage: \/mod new <what the mod should do>/);
    }
  });

  it('submits a prompt that runs the mod-writing playbook on the description', async () => {
    const r = await handleSlashCommand('/mod new show the time under the prompt', 'sess', process.cwd());
    expect(r.handled).toBe(true);
    expect(r.action?.type).toBe('submit_prompt');
    if (r.action?.type !== 'submit_prompt') return;
    expect(r.action.commandName).toBe('/mod new');
    expect(r.action.rawInput).toBe('/mod new show the time under the prompt');
    expect(r.action.allowedTools).toBeUndefined();
    const p = r.action.prompt;
    expect(p).toContain('**modsmith** skill');
    expect(p).toContain('Write a QodeX mod that does this: show the time under the prompt');
    expect(p).toContain('~/.qodex/mods/<name>/register.js');
    expect(p).toContain('qodex mod validate');
    expect(p).toContain('/reload-mods');
  });

  it('is in the slash catalog and /help', async () => {
    const entry = SLASH_CATALOG.find(c => c.name === 'mod');
    expect(entry).toEqual({ name: 'mod', args: 'new <description>', description: 'Have QodeX write a mod for you' });
    const help = (await handleSlashCommand('/help', 'sess', process.cwd())).message ?? '';
    expect(help).toMatch(/\/mod new <description>/);
  });
});

describe('the modsmith skill', () => {
  it('parses through the real loader and says where the consent moment is', () => {
    const spec = parseSkill(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'), 'modsmith', SKILL_DIR, 'builtin');
    expect(spec).not.toBeNull();
    expect(spec!.description).toMatch(/QodeX mod/);
    expect(spec!.triggers).toEqual(['mod', 'mods', 'modding', 'مود']);
    const b = spec!.body;
    expect(b).toContain('asks the user before any write');
    expect(b).toContain('in every approval mode');
    expect(b).toContain('consent');
    for (const s of ['tool.call', 'ui.render', '$.ui.status', '$.store.get', '$.model.complete', 'Ctrl+X Tab', 'docs/MODS.md']) {
      expect(b).toContain(s);
    }
    expect(b.length).toBeLessThan(7000); // a playbook, not a manual
  });
});

describe('skill auto-loading stays quiet for prompts that are not about mods', () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-modsmith-home-'));
  const ORIG_HOME = process.env.HOME;
  let R: typeof import('../src/skills/registry.js');

  beforeAll(async () => {
    process.env.HOME = HOME;
    const dst = path.join(HOME, '.qodex', 'skills');
    fs.mkdirSync(dst, { recursive: true });
    for (const d of fs.readdirSync(BUNDLED)) fs.cpSync(path.join(BUNDLED, d), path.join(dst, d), { recursive: true });
    R = await import('../src/skills/registry.js');
    await R.initSkillRegistry(HOME);
  });

  afterAll(() => {
    if (ORIG_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG_HOME;
    fs.rmSync(HOME, { recursive: true, force: true });
  });

  it('never picks modsmith for everyday requests, and ranks it first for mod requests', () => {
    expect(R.listSkills().map(s => s.name)).toContain('modsmith');
    for (const p of [
      'create a login page', 'create tests for the parser', 'add a status line to the footer of my react app',
      'show the token usage above the prompt', 'refactor the module loader', 'fix the model selection bug',
    ]) {
      expect(R.suggestSkillForPrompt(p), p).not.toBe('modsmith');
    }
    expect(R.searchInstalledSkills('make a mod that shows the time above the prompt', 1)[0]?.name).toBe('modsmith');
    expect(R.searchInstalledSkills('write a QodeX mod that blocks rm -rf', 1)[0]?.name).toBe('modsmith');
  });
});
