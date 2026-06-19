import { describe, it, expect } from 'vitest';
import { resolveKnownSkill, searchGitHubForSkill } from '../src/skills/skill-sources.js';

describe('resolveKnownSkill', () => {
  it('resolves a known alias to a gh: source', () => {
    const r = resolveKnownSkill('emil');
    expect(r).toBeDefined();
    expect(r!.source.startsWith('gh:')).toBe(true);
  });

  it('is case- and spacing-insensitive', () => {
    expect(resolveKnownSkill('Emil Kowalski')).toBeDefined();
    expect(resolveKnownSkill('SHADCN')).toBeDefined();
  });

  it('returns undefined for an unknown name', () => {
    expect(resolveKnownSkill('totally-made-up-skill-xyz')).toBeUndefined();
  });
});

describe('searchGitHubForSkill', () => {
  // Inject a fake fetch so we never hit the network.
  function fakeFetch(repoSearchItems: any[], hasManifest: boolean) {
    return (async (url: string) => {
      if (String(url).includes('api.github.com/search')) {
        return { ok: true, json: async () => ({ items: repoSearchItems }) } as any;
      }
      // raw SKILL.md check
      return { ok: hasManifest } as any;
    }) as unknown as typeof fetch;
  }

  it('returns a confirmed source when a repo has SKILL.md', async () => {
    const f = fakeFetch(
      [{ name: 'cool-skill', full_name: 'someone/cool-skill', default_branch: 'main', stargazers_count: 9 }],
      true,
    );
    const hit = await searchGitHubForSkill('cool', f);
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe('gh:someone/cool-skill');
    expect(hit!.confirmed).toBe(true);
  });

  it('returns an unconfirmed best-match when no SKILL.md is found', async () => {
    const f = fakeFetch(
      [{ name: 'maybe-skill', full_name: 'x/maybe-skill', default_branch: 'main', stargazers_count: 3 }],
      false,
    );
    const hit = await searchGitHubForSkill('maybe', f);
    expect(hit).not.toBeNull();
    expect(hit!.confirmed).toBe(false);
  });

  it('returns null when search has no items', async () => {
    const f = fakeFetch([], false);
    const hit = await searchGitHubForSkill('nothing', f);
    expect(hit).toBeNull();
  });

  it('returns null on network failure', async () => {
    const f = (async () => { throw new Error('no network'); }) as unknown as typeof fetch;
    const hit = await searchGitHubForSkill('anything', f);
    expect(hit).toBeNull();
  });
});
