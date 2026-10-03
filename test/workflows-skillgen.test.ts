import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildWorkflowSkillMarkdown,
  deriveTriggers,
  removeWorkflowSkill,
  writeWorkflowSkill,
  setWorkflowSkillsDirForTests,
  getWorkflowSkillsDir,
} from '../src/workflows/skillgen.js';
import { parseSkill, loadSkills } from '../src/skills/loader.js';
import type { Workflow } from '../src/workflows/types.js';

const wf: Workflow = {
  name: 'digikala-search',
  title: 'جستجو در دیجی‌کالا',
  description: 'Search Digikala for a product and read the cheapest price, قیمت ارزان‌ترین کالا',
  version: 1,
  createdAt: '2026-10-01T10:00:00.000Z',
  source: 'human',
  startUrl: 'https://www.digikala.com/',
  params: [
    { name: 'query', description: 'Text for searchbox "Search"', example: 'گوشی' },
    { name: 'password', description: 'Secret for textbox "Password"', secret: true, vaultField: 'password' },
    { name: 'region', example: 'tehran', default: 'tehran' },
  ],
  steps: [
    { kind: 'navigate', url: 'https://www.digikala.com/' },
    { kind: 'fill', selector: '[name="q"]', role: 'searchbox', name: 'Search', value: '{{query}}' },
    { kind: 'fill', selector: '#pw', value: '{{password}}' },
    { kind: 'fill', selector: '#region', value: '{{region}}' },
    { kind: 'press', key: 'Enter' },
    { kind: 'extract', selector: '.price', optional: true },
  ],
};

describe('workflow skill generation', () => {
  it('produces frontmatter the real skills loader parses', () => {
    const md = buildWorkflowSkillMarkdown(wf);
    const spec = parseSkill(md, 'workflow-digikala-search', '/tmp/x', 'user');
    expect(spec).not.toBeNull();
    expect(spec!.description.startsWith("Replay the recorded 'جستجو در دیجی‌کالا' workflow: Search Digikala")).toBe(true);
    expect(spec!.allowedTools).toContain('workflow_run');
    expect(spec!.allowedTools).toContain('browser_snapshot');
    expect(spec!.triggers).toEqual(expect.arrayContaining(['digikala search', 'digikala', 'product', 'cheapest', 'قیمت', 'ارزانترین']));
    for (const tr of spec!.triggers!) expect(tr).not.toMatch(/[,[\]]/);
    expect(spec!.source).toBe('workflow:digikala-search');
    expect(spec!.body).toContain('workflow_run {"name": "digikala-search", "params": [{"name": "query", "value": "گوشی"}, {"name": "password", "value": "vault:<entry>"}]}');
    expect(spec!.body).toContain('`password` — Secret for textbox "Password"; SECRET');
    expect(spec!.body).toContain('`region` — recorded example: "tehran"; default: "tehran"; optional');
    expect(spec!.body).toContain('6. extract text of .price (optional)');
    expect(spec!.body).toMatch(/start_step/);
  });

  it('keeps the description on one line and short', () => {
    const md = buildWorkflowSkillMarkdown({ ...wf, description: 'line one\nline two: with --- dashes\n'.repeat(40) });
    const fmLine = md.split('\n').find(l => l.startsWith('description: '))!;
    expect(fmLine.length).toBeLessThanOrEqual('description: '.length + 300);
    expect(parseSkill(md, 'workflow-x', '/tmp/x', 'user')!.description).toContain('line one line two');
  });

  it('derives triggers without stopwords or duplicates', () => {
    const tr = deriveTriggers({ ...wf, title: undefined, description: 'Book a table for the dinner at the restaurant', startUrl: 'https://www.resy.example/' });
    expect(tr).toContain('book');
    expect(tr).toContain('restaurant');
    expect(tr).toContain('resy.example');
    expect(tr).not.toContain('the');
    expect(tr).not.toContain('for');
    expect(new Set(tr).size).toBe(tr.length);
  });

  describe('on disk', () => {
    let home: string;
    const prevHome = process.env.HOME;
    beforeEach(async () => {
      home = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-wf-skill-'));
      process.env.HOME = home; // userSkillsDir() → <home>/.qodex/skills
      setWorkflowSkillsDirForTests(null);
    });
    afterEach(async () => {
      process.env.HOME = prevHome;
      setWorkflowSkillsDirForTests(null);
      await fs.rm(home, { recursive: true, force: true });
    });

    it('writes into the user skills dir where loadSkills discovers it', async () => {
      expect(getWorkflowSkillsDir()).toBe(path.join(home, '.qodex', 'skills'));
      const r = await writeWorkflowSkill(wf);
      expect(r.written).toBe(true);
      expect(r.file).toBe(path.join(home, '.qodex', 'skills', 'workflow-digikala-search', 'SKILL.md'));
      const skills = await loadSkills(path.join(home, 'project'));
      const s = skills.get('workflow-digikala-search');
      expect(s).toBeDefined();
      expect(s!.origin).toBe('user');
      expect(s!.description).toMatch(/^Replay the recorded/);
      // Regenerating (e.g. after re-recording) overwrites our own file.
      const again = await writeWorkflowSkill({ ...wf, description: 'Updated' });
      expect(again.written).toBe(true);
      expect(await fs.readFile(again.file, 'utf-8')).toContain('Updated');
      expect(await removeWorkflowSkill('digikala-search')).toBe(true);
      expect((await loadSkills(path.join(home, 'project'))).has('workflow-digikala-search')).toBe(false);
    });

    it('never overwrites or removes a hand-written skill with the same name', async () => {
      const dir = path.join(home, '.qodex', 'skills', 'workflow-digikala-search');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: workflow-digikala-search\ndescription: mine\n---\nhand made\n');
      const r = await writeWorkflowSkill(wf);
      expect(r.written).toBe(false);
      expect(r.reason).toMatch(/hand-written/);
      expect(await removeWorkflowSkill('digikala-search')).toBe(false);
      expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8')).toContain('hand made');
    });

    it('honors an injected skills dir', async () => {
      const alt = path.join(home, 'alt-skills');
      setWorkflowSkillsDirForTests(alt);
      const r = await writeWorkflowSkill(wf);
      expect(r.file.startsWith(alt)).toBe(true);
    });
  });
});
