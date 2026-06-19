import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseSkill } from '../src/skills/loader.js';
import { MediaTransformTool } from '../src/tools/media/ffmpeg-tools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..', 'examples', 'skills', 'ad-studio');

async function loadShipped() {
  const raw = await fs.readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  return parseSkill(raw, 'ad-studio', SKILL_DIR, 'builtin');
}

describe('ad-studio bundled skill', () => {
  it('parses through the real loader with required fields', async () => {
    const spec = await loadShipped();
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe('ad-studio');
    expect(spec!.description.length).toBeGreaterThan(80);
    expect(spec!.version).toBe('1.0.0');
  });

  it('registers ad slash aliases + bilingual triggers', async () => {
    const spec = await loadShipped();
    expect(spec!.slashAliases).toContain('ad');
    expect(spec!.triggers).toContain('storyboard');
    expect(spec!.triggers?.some(t => /[\u0600-\u06FF]/.test(t))).toBe(true);
  });

  it('covers the full pipeline: script -> Higgsfield generate -> ffmpeg assemble', async () => {
    const spec = await loadShipped();
    const b = spec!.body;
    expect(b).toContain('mcp:higgsfield');     // generation engine
    expect(b).toContain('media_transform');     // assembly
    expect(b).toContain('concat');              // join sequences -> final
    expect(b.toLowerCase()).toContain('3-second hook'); // the craft non-negotiable
    // Honest framing: a professional pipeline, not literal magic.
    expect(b.toLowerCase()).toContain('not literal magic');
  });

  it('ships frameworks + verified assembly recipes', async () => {
    const spec = await loadShipped();
    expect(spec!.files).toContain('ad-frameworks.md');
    expect(spec!.files).toContain('assembly-recipes.md');
    const asm = await fs.readFile(path.join(SKILL_DIR, 'assembly-recipes.md'), 'utf8');
    expect(asm).toContain('concat');
    expect(asm).toContain('xfade');   // transition recipe (verified to run)
    expect(asm).toContain('loudnorm');
  });
});

describe('media_transform — concat operation', () => {
  it('accepts the concat operation with an inputs array', () => {
    const t = new MediaTransformTool();
    expect(() => t.argsSchema.parse({ operation: 'concat', inputs: ['a.mp4', 'b.mp4'], output: 'out.mp4' })).not.toThrow();
  });

  it('rejects concat with fewer than 2 inputs (no ffmpeg needed for this path)', async () => {
    const t = new MediaTransformTool();
    const res = await t.execute({ operation: 'concat', inputs: ['only-one.mp4'], output: 'out.mp4' } as any, {} as any);
    expect(res.isError).toBe(true);
    expect(res.content.toLowerCase()).toContain('at least 2');
  });

  it('requires input for single-input operations', async () => {
    const t = new MediaTransformTool();
    const res = await t.execute({ operation: 'convert', output: 'out.mp4' } as any, {} as any);
    expect(res.isError).toBe(true);
    expect(res.content.toLowerCase()).toContain('requires "input"');
  });
});
