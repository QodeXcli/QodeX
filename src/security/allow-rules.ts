/**
 * User-facing execution allow-list.
 *
 * `security.autoApprove` is regex. `execution.allow` is the same gate written as
 * the command the user types (`git status`, `npm test`). A `/regex/flags` literal
 * or a pattern starting with `^` is still accepted so one list can hold both.
 *
 * Matching is prefix-on-normalized-command: `git status` allows `git status --short`
 * and does not allow `git status-extra` or `git stash`. Deny / always-ask /
 * irreversible still win in PermissionEngine — this module only answers "does
 * this rule match".
 */
import { normalizeCommand } from './command-risk.js';

export type AllowMatcher = (operation: string) => boolean;

/** Compile one rule. Malformed regex becomes a literal prefix so a typo cannot crash evaluate(). PURE. */
export function compileAllowRule(raw: string): AllowMatcher {
  const s = (raw ?? '').trim();
  if (!s) return () => false;

  const wrapped = /^\/(.*)\/([gimsuy]*)$/.exec(s);
  if (wrapped) {
    try {
      const re = new RegExp(wrapped[1]!, wrapped[2]);
      return (op) => re.test(normalizeCommand(op));
    } catch {
      return prefixMatcher(s);
    }
  }

  if (s.startsWith('^')) {
    try {
      const re = new RegExp(s);
      return (op) => re.test(normalizeCommand(op));
    } catch {
      return prefixMatcher(s);
    }
  }

  return prefixMatcher(s);
}

function prefixMatcher(raw: string): AllowMatcher {
  const norm = normalizeCommand(raw);
  if (!norm) return () => false;
  return (op) => {
    const n = normalizeCommand(op);
    return n === norm || n.startsWith(norm + ' ');
  };
}

/** First matching rule, or null. PURE. */
export function matchAllowRule(operation: string, matchers: readonly AllowMatcher[]): boolean {
  for (const m of matchers) {
    if (m(operation)) return true;
  }
  return false;
}

export function compileAllowRules(rules: readonly string[] | undefined): AllowMatcher[] {
  if (!rules?.length) return [];
  return rules.map(compileAllowRule);
}
