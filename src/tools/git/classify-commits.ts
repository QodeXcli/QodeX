/**
 * Conventional-commit + heuristic classifier for release-note generation.
 *
 * Input: a list of raw commit records.
 * Output: same records bucketed into Features / Fixes / Breaking / Internal / Other.
 *
 * The classifier is intentionally deterministic and dependency-free — the LLM step
 * (if any) happens above this layer. We expose the per-commit reason so the agent
 * can override the bucket when summarizing.
 */

export type ReleaseCategory = 'breaking' | 'features' | 'fixes' | 'perf' | 'docs' | 'internal' | 'other';

export interface RawCommit {
  sha: string;
  date: string;   // YYYY-MM-DD
  author: string;
  subject: string;
  body: string;
}

export interface ClassifiedCommit extends RawCommit {
  category: ReleaseCategory;
  scope?: string;
  /** Why this commit landed in that category (for debugging / agent override). */
  reason: string;
}

// Conventional commit subject: `type(scope)!: description`
const CONV_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?:\s*(?<desc>.+)$/i;

export function classifyCommit(c: RawCommit): ClassifiedCommit {
  const m = CONV_RE.exec(c.subject.trim());
  const bodyLower = c.body.toLowerCase();
  const hasBreakingTrailer = /\bbreaking[- ]change\b/i.test(c.body);

  if (m?.groups) {
    const type = m.groups.type!.toLowerCase();
    const scope = m.groups.scope;
    const bang = m.groups.bang === '!';
    if (bang || hasBreakingTrailer) {
      return { ...c, category: 'breaking', scope, reason: `conventional ${type}!${scope ? `(${scope})` : ''}` };
    }
    switch (type) {
      case 'feat':
      case 'feature':
        return { ...c, category: 'features', scope, reason: `conventional feat` };
      case 'fix':
      case 'bugfix':
      case 'hotfix':
        return { ...c, category: 'fixes', scope, reason: `conventional fix` };
      case 'perf':
        return { ...c, category: 'perf', scope, reason: `conventional perf` };
      case 'docs':
      case 'doc':
        return { ...c, category: 'docs', scope, reason: `conventional docs` };
      case 'refactor':
      case 'chore':
      case 'test':
      case 'tests':
      case 'ci':
      case 'build':
      case 'style':
        return { ...c, category: 'internal', scope, reason: `conventional ${type}` };
    }
  }

  if (hasBreakingTrailer) {
    return { ...c, category: 'breaking', reason: 'BREAKING CHANGE trailer in body' };
  }

  // Free-form heuristic fallback. Order matters — earlier wins.
  const subj = c.subject.toLowerCase();
  if (/\b(add|new|introduce|implement|support)\b/.test(subj)) {
    return { ...c, category: 'features', reason: 'subject suggests addition' };
  }
  if (/\b(fix|resolve|correct|patch|repair|prevent)\b/.test(subj)) {
    return { ...c, category: 'fixes', reason: 'subject suggests fix' };
  }
  if (/\b(refactor|cleanup|rename|reorganize|move|extract)\b/.test(subj)) {
    return { ...c, category: 'internal', reason: 'subject suggests refactor' };
  }
  if (/\b(doc|docs|readme|comment)\b/.test(subj)) {
    return { ...c, category: 'docs', reason: 'subject suggests docs' };
  }
  if (/\b(perf|performance|optimi[sz]e|speed)\b/.test(subj)) {
    return { ...c, category: 'perf', reason: 'subject suggests perf' };
  }
  if (bodyLower.includes('breaking')) {
    return { ...c, category: 'breaking', reason: 'body mentions breaking' };
  }
  return { ...c, category: 'other', reason: 'no signal' };
}

export interface CategoryBuckets {
  breaking: ClassifiedCommit[];
  features: ClassifiedCommit[];
  fixes: ClassifiedCommit[];
  perf: ClassifiedCommit[];
  docs: ClassifiedCommit[];
  internal: ClassifiedCommit[];
  other: ClassifiedCommit[];
}

export function bucket(commits: RawCommit[]): CategoryBuckets {
  const out: CategoryBuckets = { breaking: [], features: [], fixes: [], perf: [], docs: [], internal: [], other: [] };
  for (const c of commits) {
    const cls = classifyCommit(c);
    out[cls.category].push(cls);
  }
  return out;
}

const SECTION_LABELS: Record<ReleaseCategory, string> = {
  breaking: 'Breaking changes',
  features: 'Features',
  fixes: 'Fixes',
  perf: 'Performance',
  docs: 'Documentation',
  internal: 'Internal',
  other: 'Other',
};

export function formatMarkdown(
  buckets: CategoryBuckets,
  opts: { scope: 'user' | 'all'; heading: string; range: string },
): string {
  const showInternal = opts.scope === 'all';
  const order: ReleaseCategory[] = showInternal
    ? ['breaking', 'features', 'fixes', 'perf', 'docs', 'internal', 'other']
    : ['breaking', 'features', 'fixes', 'perf'];

  const lines: string[] = [`## ${opts.heading}`, '', `_Range: \`${opts.range}\`_`, ''];
  let any = false;
  for (const cat of order) {
    const items = buckets[cat];
    if (items.length === 0) continue;
    any = true;
    lines.push(`### ${SECTION_LABELS[cat]}`);
    for (const it of items) {
      const scopeTag = it.scope ? `**${it.scope}:** ` : '';
      lines.push(`- ${scopeTag}${stripConvPrefix(it.subject)} (\`${it.sha}\`)`);
    }
    lines.push('');
  }
  if (!any) lines.push('_No user-facing changes in this range._', '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function stripConvPrefix(subject: string): string {
  return subject.replace(CONV_RE, (_, ..._args) => {
    const groups = _args[_args.length - 1] as Record<string, string>;
    return groups.desc ?? subject;
  });
}
