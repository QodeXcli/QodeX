import { describe, it, expect } from 'vitest';
import { parseGithubLinksFromMarkdown, normalizeGithubSource } from '../src/skills/bulk-installer.js';

describe('normalizeGithubSource', () => {
  it('turns a blob URL to a SKILL.md into gh:repo@ref#dir (no trailing SKILL.md)', () => {
    const out = normalizeGithubSource(
      'https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md',
    );
    expect(out).toBe('gh:anthropics/claude-code@main#plugins/frontend-design/skills/frontend-design');
  });

  it('turns a tree URL into gh:repo@ref#subpath', () => {
    expect(normalizeGithubSource('https://github.com/u/r/tree/main/skills/foo'))
      .toBe('gh:u/r@main#skills/foo');
  });

  it('handles a plain repo URL', () => {
    expect(normalizeGithubSource('https://github.com/u/r')).toBe('gh:u/r');
  });

  it('passes through an existing gh: source unchanged', () => {
    expect(normalizeGithubSource('gh:u/r@main#x')).toBe('gh:u/r@main#x');
  });
});

describe('parseGithubLinksFromMarkdown', () => {
  it('extracts plain user/repo links', () => {
    const md = 'See [docx](https://github.com/anthropics/skills) for documents.';
    const links = parseGithubLinksFromMarkdown(md);
    expect(links).toContain('anthropics/skills');
  });

  it('captures tree/<branch>/<subpath> links with ref and subpath', () => {
    const md = '[docx](https://github.com/anthropics/skills/tree/main/document-skills/docx)';
    const links = parseGithubLinksFromMarkdown(md);
    // user/repo@ref#subpath
    expect(links).toContain('anthropics/skills@main#document-skills/docx');
  });

  it('dedupes repeated links', () => {
    const md = `
      [a](https://github.com/foo/bar)
      [b](https://github.com/foo/bar)
    `;
    const links = parseGithubLinksFromMarkdown(md);
    expect(links.filter(l => l === 'foo/bar')).toHaveLength(1);
  });

  it('strips .git suffix', () => {
    const md = '[x](https://github.com/user/repo.git)';
    const links = parseGithubLinksFromMarkdown(md);
    expect(links).toContain('user/repo');
  });

  it('ignores GitHub site-chrome links', () => {
    const md = `
      [features](https://github.com/features/copilot)
      [login](https://github.com/login)
      [real](https://github.com/obra/superpowers)
    `;
    const links = parseGithubLinksFromMarkdown(md);
    expect(links).toContain('obra/superpowers');
    expect(links.some(l => l.startsWith('features/'))).toBe(false);
    expect(links.some(l => l.startsWith('login/'))).toBe(false);
  });

  it('handles a realistic multi-source catalog row set', () => {
    const md = `
      | docx | ... | [Source](https://github.com/anthropics/skills/tree/main/document-skills/docx) |
      | superpowers | ... | [Source](https://github.com/obra/superpowers/tree/main/skills/using-git-worktrees) |
      | csv | ... | [Source](https://github.com/coffeefuelbump/csv-data-summarizer-claude-skill) |
    `;
    const links = parseGithubLinksFromMarkdown(md);
    expect(links).toContain('anthropics/skills@main#document-skills/docx');
    expect(links).toContain('obra/superpowers@main#skills/using-git-worktrees');
    expect(links).toContain('coffeefuelbump/csv-data-summarizer-claude-skill');
  });
});
