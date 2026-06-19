import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseSkill } from '../src/skills/loader.js';

// The flagship seo-geo-master skill ships bundled in examples/skills/ and is
// seeded into ~/.qodex/skills on first run. These tests guard its frontmatter
// and body against accidental breakage (a malformed `---` block silently drops
// the whole skill, so we assert it parses through the REAL loader).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..', 'examples', 'skills', 'seo-geo-master');

async function loadShipped() {
  const raw = await fs.readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  return parseSkill(raw, 'seo-geo-master', SKILL_DIR, 'builtin');
}

describe('seo-geo-master bundled skill', () => {
  it('parses through the real loader with required fields', async () => {
    const spec = await loadShipped();
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe('seo-geo-master');
    expect(spec!.description.length).toBeGreaterThan(80);
    expect(spec!.version).toBe('1.0.0');
  });

  it('registers the seo + geo slash aliases', async () => {
    const spec = await loadShipped();
    expect(spec!.slashAliases).toContain('seo');
    expect(spec!.slashAliases).toContain('geo');
  });

  it('has bilingual triggers (English + Persian)', async () => {
    const spec = await loadShipped();
    expect(spec!.triggers).toContain('geo');
    expect(spec!.triggers).toContain('schema');
    // Persian trigger so the model loads it when the user writes in Farsi.
    expect(spec!.triggers?.some(t => /[\u0600-\u06FF]/.test(t))).toBe(true);
  });

  it('only references tools that actually exist in QodeX', async () => {
    const spec = await loadShipped();
    // A skill that lists a non-existent tool in allowed-tools would silently
    // restrict an explicit /skill run to nothing useful. Keep this in sync.
    const realTools = new Set([
      'web_search', 'web_fetch', 'tavily', 'openapi_digest', 'seo_audit',
      'browser_navigate', 'browser_get_text', 'browser_screenshot', 'browser_evaluate',
      'detect_frontend_stack', 'design_audit', 'wp_find_hook', 'wp_list_hooks',
      'read_file', 'write_file', 'edit_text', 'multi_edit', 'multi_file_edit',
      'ls', 'glob', 'grep',
    ]);
    for (const t of spec!.allowedTools ?? []) {
      expect(realTools.has(t), `allowed-tool "${t}" is not a known QodeX tool`).toBe(true);
    }
  });

  it('declares the schema-recipes reference file and it exists on disk', async () => {
    const spec = await loadShipped();
    expect(spec!.files).toContain('schema-recipes.md');
    const recipes = await fs.readFile(path.join(SKILL_DIR, 'schema-recipes.md'), 'utf8');
    // Spot-check it carries real, high-leverage templates.
    expect(recipes).toContain('FAQPage');
    expect(recipes).toContain('hreflang');
    expect(recipes).toContain('llms.txt');
  });

  it('body covers both SEO and GEO, not just one', async () => {
    const spec = await loadShipped();
    const body = spec!.body;
    expect(body).toContain('GEO');
    expect(body).toContain('Core Web Vitals');
    expect(body).toContain('INP'); // must teach INP, not the deprecated FID
    expect(body).not.toContain('optimize for FID'); // guard against stale advice
    expect(body).toContain('llms.txt');
  });
});
