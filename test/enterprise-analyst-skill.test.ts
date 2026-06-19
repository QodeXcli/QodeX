import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseSkill } from '../src/skills/loader.js';

// The flagship enterprise-analyst skill ships bundled and seeds into ~/.qodex/skills.
// These tests guard its frontmatter + body and confirm its shipped Python recipes are
// real (the skill's whole value is "compute, don't guess" — broken recipes defeat it).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..', 'examples', 'skills', 'enterprise-analyst');

async function loadShipped() {
  const raw = await fs.readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  return parseSkill(raw, 'enterprise-analyst', SKILL_DIR, 'builtin');
}

describe('enterprise-analyst bundled skill', () => {
  it('parses through the real loader with required fields', async () => {
    const spec = await loadShipped();
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe('enterprise-analyst');
    expect(spec!.description.length).toBeGreaterThan(80);
    expect(spec!.version).toBe('1.0.0');
  });

  it('registers analysis slash aliases', async () => {
    const spec = await loadShipped();
    expect(spec!.slashAliases).toContain('analyze');
    expect(spec!.slashAliases).toContain('strategy');
  });

  it('has bilingual triggers (English + Persian)', async () => {
    const spec = await loadShipped();
    expect(spec!.triggers).toContain('unit economics');
    expect(spec!.triggers?.some(t => /[\u0600-\u06FF]/.test(t))).toBe(true);
  });

  it('grants code_run + data tools (compute, not guess)', async () => {
    const spec = await loadShipped();
    // code_run is the linchpin — the skill mandates computing numbers, not stating them.
    expect(spec!.allowedTools).toContain('code_run');
    expect(spec!.allowedTools).toContain('web_search');
    expect(spec!.allowedTools).toContain('xlsx_read');
    const realTools = new Set([
      'web_search', 'web_fetch', 'tavily', 'code_run', 'xlsx_read', 'csv_read',
      'csv_write', 'db_query', 'openapi_digest', 'read_file', 'write_file',
      'grep', 'glob', 'ls',
    ]);
    for (const t of spec!.allowedTools ?? []) {
      expect(realTools.has(t), `allowed-tool "${t}" is not a known QodeX tool`).toBe(true);
    }
  });

  it('body enforces the no-guessing discipline and a real process', async () => {
    const spec = await loadShipped();
    const b = spec!.body;
    // whitespace-tolerant: the phrase may wrap across a line in the prose.
    const bNorm = b.replace(/\s+/g, ' ');
    expect(bNorm).toContain('computed, not guessed');
    expect(b).toContain('[ASSUMPTION]');
    expect(b).toContain('sensitivity');
    expect(b).toContain('BLUF');
    expect(b).toContain('bottom-up'); // TAM must be built up, not "1% of big number"
  });

  it('ships frameworks + financial-model reference files', async () => {
    const spec = await loadShipped();
    expect(spec!.files).toContain('frameworks.md');
    expect(spec!.files).toContain('financial-models.md');
    const frameworks = await fs.readFile(path.join(SKILL_DIR, 'frameworks.md'), 'utf8');
    expect(frameworks).toContain('LTV');
    expect(frameworks).toContain('NPV');
    const models = await fs.readFile(path.join(SKILL_DIR, 'financial-models.md'), 'utf8');
    // The recipes must be pure stdlib so they run on any Mac with no install.
    expect(models).not.toContain('import numpy');
    expect(models).not.toContain('import pandas');
    expect(models).toContain('def npv(');
    expect(models).toContain('def irr(');
  });
});
