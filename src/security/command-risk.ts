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
 *   2. Irreversible commands can never hold a standing grant at all — they are confirmed
 *      every time, including under auto-approve/yolo.
 *
 * Normalization is deliberately conservative: it collapses whitespace and strips quoting so
 * cosmetic variants share a grant, but it NEVER discards an argument. `rm -rf /tmp/x` and
 * `rm -rf /` must never normalize to the same key — the tests assert exactly that.
 */

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

/**
 * Irreversible patterns. Each entry explains itself, because the message the user sees when
 * we refuse a blanket grant IS this reason.
 */
const IRREVERSIBLE: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, reason: 'recursive/forced delete' },
  { re: /\brmdir\s+\/(\s|$)/, reason: 'removing a root directory' },
  { re: /\bgit\s+push\b.*(--force|-f)\b/, reason: 'force push rewrites remote history' },
  { re: /\bgit\s+reset\s+--hard\b/, reason: 'discards uncommitted work irrecoverably' },
  { re: /\bgit\s+clean\b.*-[a-zA-Z]*f/, reason: 'deletes untracked files' },
  { re: /\bgit\s+(filter-branch|filter-repo)\b/, reason: 'rewrites history' },
  { re: /\bdd\s+(if|of)=/, reason: 'raw disk write' },
  { re: /\bmkfs(\.|\s)/, reason: 'formats a filesystem' },
  { re: /\b(shutdown|reboot|halt)\b/, reason: 'takes the machine down' },
  { re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: 'destroys database objects' },
  { re: /\bTRUNCATE\s+TABLE\b/i, reason: 'empties a table' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, reason: 'executes code downloaded from the network' },
  { re: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?[0-7]*777\s+\/(\s|$)/, reason: 'world-writable root' },
  { re: /\b(chown|chmod)\s+-[a-zA-Z]*R[a-zA-Z]*\s+\/(\s|$)/, reason: 'recursive permission change on /' },
  { re: /\bnpm\s+(publish|unpublish)\b/, reason: 'publishes to a public registry' },
  { re: /\b(kubectl|helm)\s+delete\b/, reason: 'deletes cluster resources' },
  { re: /\bterraform\s+(destroy|apply)\b/, reason: 'changes real infrastructure' },
  { re: /\baws\s+.*\b(delete|terminate)-/, reason: 'deletes cloud resources' },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, reason: 'fork bomb' },
  { re: />\s*\/dev\/(sd|nvme|disk)/, reason: 'writes directly to a block device' },
];

/** Commands that change state but are recoverable — no blanket ban, still not "safe". */
const MUTATING: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|ci)\b/,
  /\bpip3?\s+(install|uninstall)\b/,
  /\bgit\s+(commit|push|merge|rebase|checkout|switch|stash|apply|cherry-pick|revert|tag)\b/,
  /\b(mv|cp|mkdir|touch|ln)\b/,
  /\brm\b/,                      // a plain rm without -rf is still a delete
  /\b(docker|podman)\s+(run|rm|rmi|build|compose)\b/,
  /\bsudo\b/,
  /\bmake\b/,
  /\b(systemctl|launchctl|service)\b/,
  /\b(chmod|chown)\b/,
  /\b(brew|apt|apt-get|yum|dnf|pacman)\s+(install|remove|upgrade)\b/,
];

/** Read-only commands worth recognising so we do not nag about them. */
const SAFE: RegExp[] = [
  /^\s*(ls|pwd|cat|head|tail|wc|file|stat|which|type|echo|date|whoami|env|printenv)\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|describe|rev-parse|blame)\b/,
  /^\s*(grep|rg|find|fd|ag)\b/,
  /^\s*(npm|pnpm|yarn|bun)\s+(test|run\s+test|ls|list|view|outdated)\b/,
  /^\s*(node|python3?|tsx?)\s+--version\b/,
  /^\s*(docker|kubectl)\s+(ps|logs|images|get)\b/,
];

/**
 * Classify a command. PURE.
 *
 * Order matters: irreversible wins over mutating wins over safe, because a command can match
 * several sets (`git push --force` is both a git write and a history rewrite) and the most
 * dangerous reading must be the one that governs.
 */
export function assessCommand(command: string): RiskAssessment {
  const cmd = (command ?? '').trim();
  if (!cmd) return { tier: 'safe', reason: 'empty command', neverBlanket: false };

  for (const { re, reason } of IRREVERSIBLE) {
    if (re.test(cmd)) return { tier: 'irreversible', reason, neverBlanket: true };
  }
  for (const re of MUTATING) {
    if (re.test(cmd)) return { tier: 'mutating', reason: 'changes state on disk or remotely', neverBlanket: false };
  }
  for (const re of SAFE) {
    if (re.test(cmd)) return { tier: 'safe', reason: 'read-only', neverBlanket: false };
  }
  // Unrecognised: treat as mutating. Assuming an unknown command is harmless is the wrong
  // default for something running unattended.
  return { tier: 'mutating', reason: 'unrecognised command — treated as state-changing', neverBlanket: false };
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
