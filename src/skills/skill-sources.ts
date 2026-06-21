/**
 * Skill source resolution.
 *
 * Problem: the user says "load the emil skill" or "install the shadcn skill",
 * but `install_skill` needs a concrete source like `gh:GLips/emilkowalski-skill`.
 * The model had no way to turn a bare name into a repo, so it either guessed
 * (wrong) or gave up.
 *
 * This resolves a human name to an installable `gh:` source in two stages:
 *   1. A curated registry of well-known skills (instant, offline).
 *   2. A GitHub code/repo search fallback (network) for anything not curated —
 *      we look for repos whose name matches AND that contain a SKILL.md.
 *
 * Stage 2 needs network; on the sandbox it's unavailable, but on the user's
 * machine (with their proxy) it works. We never auto-install from a fuzzy
 * search result without surfacing what we picked.
 */

export interface KnownSkill {
  /** Canonical id + the aliases a user might type. */
  names: string[];
  /** Installable source for install_skill / bulk-installer. */
  source: string;
  /** One-line description for confirmation messages. */
  description: string;
}

/**
 * Curated, high-signal skills. Keep this small and trustworthy — it's the
 * fast path. Anything not here goes through GitHub search.
 *
 * NOTE: sources are the public repos these skills are distributed from. If a
 * repo moves, update here; the search fallback will still find a moved repo.
 */
export const KNOWN_SKILLS: KnownSkill[] = [
  {
    names: ['emil', 'emilkowalski', 'emil-kowalski', 'animations'],
    source: 'gh:GLips/emilkowalski-skill',
    description: 'Emil Kowalski animation playbook (framer-motion, tactile UI)',
  },
  {
    names: ['shadcn', 'shadcn-ui', 'shadcnui'],
    source: 'gh:jadenmiltz/shadcn-skill',
    description: 'shadcn/ui component patterns and composition',
  },
  {
    // Anthropic's skills repo is a MONOREPO (skills/<name>/SKILL.md). The old
    // `#tailwind` subpath never existed there; the frontend-design skill is the
    // real home for Tailwind + design-token guidance. The installer scopes to the
    // `#skills/frontend-design` subpath and installs just that one.
    names: ['frontend-design', 'tailwind', 'tailwindcss', 'frontend-ui'],
    source: 'gh:anthropics/skills#skills/frontend-design',
    description: 'Anthropic frontend-design skill — modern UI, Tailwind & design-token guidance',
  },
  {
    names: ['algorithmic-art', 'generative-art'],
    source: 'gh:anthropics/skills#skills/algorithmic-art',
    description: 'Anthropic algorithmic-art skill — generative/p5.js visual art',
  },
];

/**
 * Given a user prompt and the names of already-installed skills, suggest ONE
 * curated skill that matches the task but isn't installed — or null. This powers
 * a user-facing hint ("this skill is available, install it?"); it never installs
 * anything itself. The decision stays with the user, not the model: when a skill
 * is missing, the safe move is to surface the option, not auto-pull repos.
 *
 * Conservative match: a distinctive skill name (>=4 chars) must appear as a whole
 * word in the prompt, and none of the skill's aliases may already be installed.
 */
export function suggestUninstalledSkill(prompt: string, installed: string[]): KnownSkill | null {
  const p = ` ${prompt.toLowerCase()} `;
  const installedSet = new Set(installed.map(n => n.toLowerCase()));
  for (const skill of KNOWN_SKILLS) {
    if (skill.names.some(n => installedSet.has(n.toLowerCase()))) continue; // already have it
    const hit = skill.names.some(n => {
      if (n.length < 4) return false;
      const esc = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(p);
    });
    if (hit) return skill;
  }
  return null;
}

/** Match a bare name against the curated registry (case-insensitive). */
export function resolveKnownSkill(name: string): KnownSkill | undefined {
  const want = name.trim().toLowerCase().replace(/\s+/g, '-');
  return KNOWN_SKILLS.find(s => s.names.some(n => n === want))
    ?? KNOWN_SKILLS.find(s => s.names.some(n => want.includes(n) || n.includes(want)));
}

/**
 * Search GitHub for a repo that looks like a skill matching `name`.
 * Returns a `gh:owner/repo` source, or null on no match / no network.
 *
 * Strategy: query the repo-search API for the name plus "skill", rank repos
 * that (a) name-match and (b) we can confirm contain a SKILL.md. We only fetch
 * the top few candidates' file listing to confirm, to stay cheap.
 */
export async function searchGitHubForSkill(
  name: string,
  fetchImpl?: typeof fetch,
): Promise<{ source: string; repo: string; confirmed: boolean } | null> {
  // Default to the proxy-aware fetch so this works behind the user's HTTPS_PROXY
  // (GitHub is often only reachable through it). Tests can inject a stub.
  if (!fetchImpl) {
    const { proxyFetch } = await import('../utils/proxy-fetch.js');
    fetchImpl = proxyFetch as unknown as typeof fetch;
  }
  const q = encodeURIComponent(`${name} skill in:name,description,readme`);
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=5`;
  let json: any;
  try {
    const res = await fetchImpl(url, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'qodex' },
    });
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null; // no network / rate-limited
  }
  const items: any[] = json?.items ?? [];
  if (items.length === 0) return null;

  const want = name.toLowerCase();
  // Prefer a repo whose name contains the term; fall back to the top result.
  const ranked = items.slice().sort((a, b) => {
    const an = a.name?.toLowerCase().includes(want) ? 1 : 0;
    const bn = b.name?.toLowerCase().includes(want) ? 1 : 0;
    if (an !== bn) return bn - an;
    return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
  });

  // Confirm a SKILL.md in the top candidate (cheap contents check).
  for (const item of ranked.slice(0, 3)) {
    const full = item.full_name; // owner/repo
    const branch = item.default_branch ?? 'main';
    const confirmed = await hasSkillManifest(full, branch, fetchImpl);
    if (confirmed) return { source: `gh:${full}`, repo: full, confirmed: true };
  }
  // Nothing confirmed — return the best name match unconfirmed so the caller
  // can decide whether to try it (install will fail cleanly if it's not a skill).
  const best = ranked[0];
  return best ? { source: `gh:${best.full_name}`, repo: best.full_name, confirmed: false } : null;
}

/** Does owner/repo contain a SKILL.md at root or one level down? Cheap check. */
async function hasSkillManifest(
  fullName: string,
  branch: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  // Try the raw URL at root first (one request, no API quota).
  const rootRaw = `https://raw.githubusercontent.com/${fullName}/${branch}/SKILL.md`;
  try {
    const res = await fetchImpl(rootRaw, { method: 'GET', headers: { 'User-Agent': 'qodex' } });
    if (res.ok) return true;
  } catch { /* ignore */ }
  return false;
}
