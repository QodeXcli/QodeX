import { describe, it, expect } from 'vitest';
import { splitFrontmatter, toAgentSkill, fromAgentSkill, skillSlug } from '../src/skills/interop.ts';

const QODEX_MD = `---
name: add-pagination
description: Cursor-paginate a REST endpoint
provenance: machine
status: candidate
confidence: 82
---

# Add pagination
Do the thing.`;

describe('splitFrontmatter', () => {
  it('parses keys + body; no frontmatter ⇒ whole text is body', () => {
    const f = splitFrontmatter(QODEX_MD);
    expect(f.keys).toContainEqual(['name', 'add-pagination']);
    expect(f.body.trim()).toMatch(/^# Add pagination/);
    expect(splitFrontmatter('just body').keys).toEqual([]);
  });
});

describe('toAgentSkill — QodeX → standard', () => {
  it('keeps name + description, DROPS internal keys (provenance/status/confidence)', () => {
    const std = toAgentSkill(QODEX_MD);
    expect(std).toContain('name: add-pagination');
    expect(std).toContain('description: Cursor-paginate a REST endpoint');
    expect(std).not.toContain('provenance');
    expect(std).not.toContain('status');
    expect(std).not.toContain('confidence');
    expect(std).toContain('# Add pagination'); // body preserved
  });
  it('carries through standard extras like license', () => {
    expect(toAgentSkill(`---\nname: x\ndescription: d\nlicense: MIT\n---\nbody`)).toContain('license: MIT');
  });
});

describe('fromAgentSkill — standard → QodeX', () => {
  it('stamps provenance: imported and preserves name/description/body', () => {
    const std = `---\nname: web-scrape\ndescription: scrape a page\n---\n\n# Scrape\nsteps`;
    const q = fromAgentSkill(std);
    expect(q).toContain('name: web-scrape');
    expect(q).toContain('description: scrape a page');
    expect(q).toContain('provenance: imported');
    expect(q).toContain('# Scrape');
  });
  it('round-trips name/description through export→import', () => {
    const back = splitFrontmatter(fromAgentSkill(toAgentSkill(QODEX_MD)));
    expect(back.keys).toContainEqual(['name', 'add-pagination']);
    expect(back.keys).toContainEqual(['description', 'Cursor-paginate a REST endpoint']);
    expect(back.keys).toContainEqual(['provenance', 'imported']); // re-stamped as external
  });
});

describe('skillSlug', () => {
  it('slugifies the frontmatter name', () => {
    expect(skillSlug(`---\nname: My Cool Skill!\ndescription: d\n---\nb`)).toBe('my-cool-skill');
    expect(skillSlug('no frontmatter', 'fallback')).toBe('fallback');
  });
});
