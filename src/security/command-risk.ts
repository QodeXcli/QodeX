/**
 * Command risk classification and grant scoping.
 *
 * THE BUG THIS FIXES: "always allow" used to store a pattern built from the command's FIRST
 * WORD (`permissions.ts` → `req.operation.split(/\s+/)[0]`), so approving `git status` wrote
 * `^git( |$)` and silently auto-approved `git push --force` and `git reset --hard` for the
 * rest of the session. Approving `rm -rf /tmp/build` auto-approved `rm -rf /`.
 *
 * That is precisely how an unattended run does something irreversible — and it is the one
 * failure mode our rollback CANNOT undo: the transaction journal covers journaled file
 * writes, not a destructive shell command.
 *
 * Two rules replace it:
 *   1. A grant binds to the EXACT normalized command, not to a family.
 *   2. Irreversible commands can never hold a standing grant at all — in manual/edits mode
 *      they are confirmed every time. (Auto mode has its own policy, src/security/autonomy.ts:
 *      irreversible-but-inside-the-project runs; outside / remote / system asks.)
 *
 * Normalization is deliberately conservative: it collapses whitespace and strips quoting so
 * cosmetic variants share a grant, but it NEVER discards an argument. `rm -rf /tmp/x` and
 * `rm -rf /` must never normalize to the same key — the tests assert exactly that.
 */

import { analyzeShell, isNeutralSegment, type ExecSegment, type ShellAnalysis } from './shell-analyze.js';

export type RiskTier =
  | 'safe'          // read-only: ls, cat, git status
  | 'mutating'      // writes/installs, but recoverable
  | 'irreversible'; // destroys data, rewrites history, or executes remote code

export interface RiskAssessment {
  tier: RiskTier;
  /** Which rule matched — shown to the user so a block is explicable. */
  reason: string;
  /** True when this command may never receive a standing ("always") grant. */
  neverBlanket: boolean;
}


/*
 * Irreversible commands are found by the shell analyzer (src/security/shell-analyze.ts) at
 * COMMAND POSITION — executable, subcommand and flags — in every segment of a chain:
 * recursive/forced deletes, force pushes (incl. `+refspec`, `--delete`, `:branch`,
 * `--mirror`, global flags like `git -c x push -f`), `git reset --hard` / `clean -f` /
 * `checkout -- .`, `find -delete`, raw disk writes, mkfs, shutdown, DROP/TRUNCATE, dropdb,
 * redis FLUSHALL, registry publishes (npm/cargo/twine/gem/docker push…), cluster and cloud
 * deletes, terraform apply/destroy, downloaded code piped to a shell. A file called
 * `shutdown.ts` or a commit message saying "drop table" is not one of them.
 */

/** Commands that change state but are recoverable — no blanket ban, still not "safe". Anchored at command position. */
const MUTATING: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|update|ci)\b/,
  /^pip3?\s+(install|uninstall)\b/,
  /^git\s+(commit|push|merge|rebase|checkout|switch|stash|apply|cherry-pick|revert|tag|reset|clean|rm|mv|pull)\b/,
  /^(mv|cp|mkdir|touch|ln|install|rsync|scp|tee|truncate|dd)\b/,
  /^(rm|rmdir|unlink)\b/,                      // a plain rm without -rf is still a delete
  /^(docker|podman)\s+(run|rm|rmi|build|compose|push)\b/,
  /^(sudo|doas|su)\b/,
  /^make\b/,
  /^(systemctl|launchctl|service)\b/,
  /^(chmod|chown|chgrp)\b/,
  /^(brew|apt|apt-get|yum|dnf|pacman)\s+(install|remove|upgrade|uninstall|reinstall)\b/,
];

/** Read-only commands worth recognising so we do not nag about them. Anchored at command position. */
const SAFE: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|file|stat|which|type|echo|date|whoami|env|printenv)\b/,
  /^git\s+(status|log|diff|show|branch|remote|describe|rev-parse|blame)\b/,
  /^(grep|rg|find|fd|ag)\b/,
  /^(npm|pnpm|yarn|bun)\s+(test|run\s+test|ls|list|view|outdated)\b/,
  /^(node|python3?|tsx?)\s+--version\b/,
  /^(docker|kubectl)\s+(ps|logs|images|get)\b/,
];

/**
 * The text of a segment seen from each command position (the executable, and the command
 * after each wrapper like sudo/env/nohup). Command-position patterns match at index 0 of a
 * view. PURE.
 */
export function commandViews(seg: ExecSegment): string[] {
  const views = seg.cmdOffsets.map(o => seg.text.slice(o)).filter(Boolean);
  return views.length ? views : [seg.ruleText];
}

/** Does `re` match at a command position of any segment (never inside an argument)? PURE. */
export function matchesAtCommandPosition(re: RegExp, a: ShellAnalysis): boolean {
  for (const seg of a.segments) {
    for (const view of commandViews(seg)) {
      re.lastIndex = 0;
      const m = re.exec(view);
      if (m && m.index === 0) return true;
    }
  }
  return false;
}

/** Tier of an analyzed command (see assessCommand). PURE. */
export function assessAnalysis(a: ShellAnalysis): RiskAssessment {
  const irr = a.findings.find(f => f.irreversible);
  if (irr) return { tier: 'irreversible', reason: irr.reason, neverBlanket: true };
  if (a.parseError) return { tier: 'mutating', reason: `could not be parsed (${a.parseError}) — treated as state-changing`, neverBlanket: false };
  if (a.findings.length || a.outsideWrites.length) return { tier: 'mutating', reason: a.findings[0]?.reason ?? 'writes outside the project', neverBlanket: false };
  let allSafe = true;
  for (const seg of a.segments) {
    if (isNeutralSegment(seg)) continue;
    const views = commandViews(seg);
    if (views.some(v => MUTATING.some(re => re.test(v)))) {
      return { tier: 'mutating', reason: 'changes state on disk or remotely', neverBlanket: false };
    }
    if (!views.some(v => SAFE.some(re => re.test(v)))) allSafe = false;
  }
  if (allSafe) return { tier: 'safe', reason: 'read-only', neverBlanket: false };
  // Unrecognised: treat as mutating. Assuming an unknown command is harmless is the wrong
  // default for something running unattended.
  return { tier: 'mutating', reason: 'unrecognised command — treated as state-changing', neverBlanket: false };
}

/**
 * Classify a command. PURE apart from realpath of existing paths.
 *
 * Order matters: irreversible wins over mutating wins over safe, because a command can match
 * several sets (`git push --force` is both a git write and a history rewrite) and the most
 * dangerous reading must be the one that governs. Every segment counts: `ls && rm -rf x` is
 * irreversible.
 */
export function assessCommand(command: string, ctx: { cwd?: string; roots?: readonly string[] } = {}): RiskAssessment {
  const cmd = (command ?? '').trim();
  if (!cmd) return { tier: 'safe', reason: 'empty command', neverBlanket: false };
  const cwd = ctx.cwd ?? process.cwd();
  return assessAnalysis(analyzeShell(cmd, { cwd, roots: ctx.roots ?? [cwd] }));
}

/**
 * Normalize a command into a grant KEY. PURE.
 *
 * Collapses cosmetic differences (repeated whitespace, surrounding quotes on an argument,
 * a trailing semicolon) so `npm  test` and `npm test` share one grant. It deliberately does
 * NOT reorder, drop, or generalise arguments: the whole point is that a grant covers the
 * command the user actually saw and approved, and nothing else.
 */
export function normalizeCommand(command: string): string {
  let s = (command ?? '').trim().replace(/;+\s*$/, '');
  // Strip matching quotes around whole tokens, but keep the token itself.
  s = s.replace(/(^|\s)(['"])((?:(?!\2).)*)\2(?=\s|$)/g, (_m, pre, _q, inner) => `${pre}${inner}`);
  return s.replace(/\s+/g, ' ').trim();
}

/** Two commands share a grant only when they normalize identically. PURE. */
export function sameCommand(a: string, b: string): boolean {
  return normalizeCommand(a) === normalizeCommand(b);
}

/**
 * Can this command be granted "always"? Irreversible commands never can — the answer
 * carries the reason so the UI can explain the refusal instead of appearing broken.
 */
export function canGrantAlways(command: string): { allowed: boolean; reason?: string } {
  const risk = assessCommand(command);
  return risk.neverBlanket
    ? { allowed: false, reason: `${risk.reason} — commands like this are confirmed every time and cannot be granted permanently` }
    : { allowed: true };
}

/**
 * User-defined deny rules, which override auto-approve and yolo mode. A rule is a substring
 * or a `/regex/flags` literal. Returns the rule that matched so the block names itself.
 */
export function matchDenyRule(command: string, rules: readonly string[]): string | null {
  const cmd = normalizeCommand(command);
  for (const rule of rules) {
    if (!rule) continue;
    const m = /^\/(.*)\/([gimsuy]*)$/.exec(rule);
    try {
      if (m) {
        if (new RegExp(m[1]!, m[2]).test(cmd)) return rule;
      } else if (cmd.includes(rule)) {
        return rule;
      }
    } catch {
      // A malformed user regex must not crash the permission check; fall back to substring.
      if (cmd.includes(rule)) return rule;
    }
  }
  return null;
}
