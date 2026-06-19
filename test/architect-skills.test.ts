import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseSkill } from '../src/skills/loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.resolve(HERE, '..', 'examples', 'skills');

async function load(name: string) {
  const dir = path.join(SKILLS, name);
  const raw = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  return parseSkill(raw, name, dir, 'builtin');
}

describe('backend-architect skill', () => {
  it('parses with required fields + bilingual triggers', async () => {
    const s = await load('backend-architect');
    expect(s).not.toBeNull();
    expect(s!.name).toBe('backend-architect');
    expect(s!.version).toBe('1.0.0');
    expect(s!.triggers).toContain('django');
    expect(s!.triggers?.some(t => /[\u0600-\u06FF]/.test(t))).toBe(true); // Persian
  });

  it('encodes the architect-first → build → quality → overseer lifecycle', async () => {
    const s = await load('backend-architect');
    const b = s!.body;
    expect(b).toContain('Architect FIRST');
    expect(b).toContain('DESIGN.md');           // write the design down (overseer)
    expect(b.toLowerCase()).toContain('vertical slice');
    expect(b).toContain('review_my_changes');   // self-review gate
    expect(b).toContain('backend_routemap');    // overseer mapping tool
    expect(b.toLowerCase()).toContain('migration'); // migration safety
  });

  it('keeps the honest framing (discipline, not magic; no fake benchmarks)', async () => {
    const b = (await load('backend-architect'))!.body;
    expect(b.toLowerCase()).toContain('discipline');
    expect(b.toLowerCase()).toContain('no fabricated benchmarks');
  });

  it('ships the architecture reference with the key checklists', async () => {
    const s = await load('backend-architect');
    expect(s!.files).toContain('backend-architecture.md');
    const ref = await fs.readFile(path.join(SKILLS, 'backend-architect', 'backend-architecture.md'), 'utf8');
    expect(ref.toLowerCase()).toContain('layer');
    expect(ref).toContain('N+1');
    expect(ref.toLowerCase()).toContain('migration safety');
    expect(ref.toLowerCase()).toContain('owasp');
  });
});

describe('frontend-architect skill', () => {
  it('parses with required fields + bilingual triggers', async () => {
    const s = await load('frontend-architect');
    expect(s).not.toBeNull();
    expect(s!.name).toBe('frontend-architect');
    expect(s!.triggers).toContain('three.js');
    expect(s!.triggers).toContain('gsap');
    expect(s!.triggers?.some(t => /[\u0600-\u06FF]/.test(t))).toBe(true);
  });

  it('covers RSC discipline, GSAP cleanup, and Three.js disposal', async () => {
    const b = (await load('frontend-architect'))!.body;
    expect(b).toContain('Server Components by default');
    expect(b).toContain('useGSAP');               // auto-cleanup pattern
    expect(b).toContain('ScrollTrigger');         // must be killed on unmount
    expect(b.toLowerCase()).toContain('dispose'); // Three.js memory discipline
    expect(b).toContain('frameloop');             // demand rendering perf
    expect(b).toContain('Core Web Vitals');
  });

  it('ships the architecture reference with the key patterns', async () => {
    const s = await load('frontend-architect');
    expect(s!.files).toContain('frontend-architecture.md');
    const ref = await fs.readFile(path.join(SKILLS, 'frontend-architect', 'frontend-architecture.md'), 'utf8');
    expect(ref).toContain('use client');
    expect(ref).toContain('useGSAP');
    expect(ref.toLowerCase()).toContain('dispose');
    expect(ref).toContain('LCP');
  });

  it('keeps the honest framing (measure, do not claim)', async () => {
    const b = (await load('frontend-architect'))!.body;
    expect(b.toLowerCase()).toContain('measure');
  });
});
