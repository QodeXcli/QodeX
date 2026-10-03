import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseSkill } from '../src/skills/loader.js';
import { scanSkillContent } from '../src/skills/security-scan.js';
import { getRegistry } from '../src/tools/registry.js';
import { runPromptAudit } from '../src/checkup/prompt-audit.js';

// build-eval and hillclimb ship in examples/skills/ and are seeded into ~/.qodex/skills on
// first run. Guard the frontmatter (a malformed block silently drops the skill), the tool
// allow-list (an unknown name restricts nothing) and the size (they are loaded into context).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.resolve(HERE, '..', 'examples', 'skills');

async function load(name: string) {
  const dir = path.join(SKILLS, name);
  const raw = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  return { raw, spec: parseSkill(raw, name, dir, 'builtin') };
}

describe.each(['build-eval', 'hillclimb'])('bundled skill %s', (name) => {
  it('parses through the real loader with a slash alias and bilingual triggers', async () => {
    const { spec } = await load(name);
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe(name);
    expect(spec!.description.length).toBeGreaterThan(80);
    expect(spec!.slashAliases).toContain(name);
    expect(spec!.triggers?.some(t => /[؀-ۿ]/.test(t))).toBe(true);
  });

  it('allows only tools QodeX really has', async () => {
    const { spec } = await load(name);
    const reg = getRegistry();
    for (const t of spec!.allowedTools ?? []) expect(reg.get(t), `unknown tool ${t}`).toBeDefined();
  });

  it('stays short and procedural (skill budget) and passes the security scan', async () => {
    const { raw, spec } = await load(name);
    expect(raw.length).toBeLessThan(4500);
    expect(spec!.body).toMatch(/evals\/<name>\//);
    expect(scanSkillContent(raw).severity).toBe('clean');
  });
});

describe('skill content follows the spec', () => {
  it('build-eval: real cases, cheapest grader first, LLM judge last, baseline after sign-off', async () => {
    const { spec } = await load('build-eval');
    const body = spec!.body;
    expect(body).toMatch(/cases\.jsonl/);
    const exact = body.indexOf('Exact match');
    const judge = body.indexOf('LLM judge');
    expect(exact).toBeGreaterThan(0);
    expect(judge).toBeGreaterThan(exact);
    expect(body).toMatch(/sign|go before any paid call/i);
    expect(body).toMatch(/results\/baseline\//);
  });

  it('hillclimb: one change at a time, holdout gate, revert overfitting, HILLCLIMB.md log', async () => {
    const { spec } = await load('hillclimb');
    const body = spec!.body;
    expect(body).toMatch(/one change per round/i);
    expect(body).toMatch(/holdout does not regress/);
    expect(body).toMatch(/revert/);
    expect(body).toMatch(/evals\/<name>\/HILLCLIMB\.md/);
    for (const knob of ['prompt', 'skills', 'tool descriptions', 'model', 'effort']) expect(body).toContain(knob);
  });

  it('prompt-audit finds nothing to fix in either skill', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-skill-audit-'));
    const cwd = path.join(home, 'proj');
    try {
      for (const n of ['build-eval', 'hillclimb']) {
        await fs.mkdir(path.join(home, '.qodex', 'skills', n), { recursive: true });
        await fs.copyFile(path.join(SKILLS, n, 'SKILL.md'), path.join(home, '.qodex', 'skills', n, 'SKILL.md'));
      }
      await fs.mkdir(cwd);
      const reg = getRegistry();
      const r = await runPromptAudit({ cwd, home, noModel: true, write: false, isKnownTool: n => !!reg.get(n) });
      expect(r.files).toHaveLength(2);
      expect(r.findings).toEqual([]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
