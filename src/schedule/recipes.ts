/**
 * Schedule recipes — turn a scheduled task into a *protocol*, not just a prompt.
 *
 * A plain scheduled task runs the user's prompt headless. A recipe wraps that intent
 * in an explicit, unattended-safe protocol the agent must follow exactly. The headline
 * recipe is **Autonomous Verified PR**: work on a sandbox branch, VERIFY, and open a PR
 * only if verification actually passed — otherwise report a block, never a false "done".
 *
 * This is the differentiator vs. a bare cron-around-a-chatbot: the same guardrails that
 * run interactively (auto-verify gate, completion gate, git sandbox, create_pr) run while
 * you're asleep, so a 24/7 run can't quietly ship broken code.
 *
 * The builder is a PURE function so the protocol is unit-tested and stable.
 */

export const RECIPES = ['verified-pr', 'maintain'] as const;
export type RecipeKind = (typeof RECIPES)[number];

export function isRecipe(s: string | undefined | null): s is RecipeKind {
  return !!s && (RECIPES as readonly string[]).includes(s);
}

/**
 * Wrap a user goal in the chosen recipe's protocol. Returns the full prompt to feed the
 * headless run. Unknown/empty recipe ⇒ the goal is returned unchanged.
 */
export function buildRecipePrompt(recipe: string | undefined | null, goal: string): string {
  if (recipe === 'verified-pr') return verifiedPrPrompt(goal);
  if (recipe === 'maintain') return maintainPrompt(goal);
  return goal;
}

const UNATTENDED_HEADER = [
  'You are running UNATTENDED on a schedule — no human is watching this run. Follow this',
  'protocol EXACTLY and do not deviate from it.',
];

/** The Autonomous Verified PR protocol — work on a sandbox branch, VERIFY, open a PR only if
 *  green, and emit an auditable receipt. Shared by `verified-pr` and `maintain`. */
const VERIFIED_PR_PROTOCOL = [
  'PROTOCOL — Autonomous Verified PR:',
  '1. Create a NEW git branch (e.g. `qodex/auto/<short-slug>`) off the current branch and do',
  '   ALL work there. NEVER commit to or push the default branch (main/master) directly.',
  '2. Make the changes the GOAL requires — and ONLY those.',
  '3. VERIFY before claiming anything: run the project\'s test command and the type/lint',
  '   checkers on the files you changed. If there is no test command, at minimum run the',
  '   language verifier (tsc / ruff / go vet / …) on every file you touched.',
  '4. DECISION GATE — mandatory:',
  '   • If verification PASSES: commit, push the branch, and open a pull request with the',
  '     `create_pr` tool. Put what you changed AND the real verification output in the PR body.',
  '   • If verification FAILS, or you are not certain it passed: DO NOT open a PR and DO NOT',
  '     claim success. Leave the branch as-is for a human, and report exactly what failed.',
  '5. End with the status line, then a machine-readable RECEIPT, and nothing after it:',
  '   First line — one of:',
  '   • `VERIFIED-PR: opened <pr-url>`            — only if you actually opened a PR, or',
  '   • `VERIFIED-PR: blocked — <one-line reason>` — if you did not.',
  '   Then a fenced receipt block recording exactly what you did, so the run is auditable:',
  '   ```qodex-receipt',
  '   {"status":"opened|blocked","branch":"<branch>","prUrl":"<url or empty>",',
  '    "verification":[{"command":"<e.g. npm test>","passed":true}],',
  '    "filesChanged":["<path>"],"summary":"<one line>","reason":"<if blocked>"}',
  '   ```',
  '',
  'Honesty rule: a green status you cannot back with real verification output is a FAILURE,',
  'not a success. The receipt must reflect what ACTUALLY ran — never report passed:true for a',
  'check you did not run. When in doubt, choose `blocked`.',
];

function verifiedPrPrompt(goal: string): string {
  return [...UNATTENDED_HEADER, '', `GOAL: ${goal.trim()}`, '', ...VERIFIED_PR_PROTOCOL].join('\n');
}

/**
 * `maintain` — the self-improving codebase recipe. v1 is deliberately the SAFEST improvement
 * there is: remove ONE piece of provably-unused dead code, proven safe via the code-graph, then
 * ship it through the same verified-PR protocol. Conservative by design — a wrong "improvement"
 * at 3am is worse than none — so it must PROVE zero references or block.
 */
function maintainPrompt(focus: string): string {
  const focusLine = focus.trim() ? `Focus area (optional hint): ${focus.trim()}.` : '';
  return [
    ...UNATTENDED_HEADER,
    '',
    'ROLE: you are a nightly code-maintenance agent. Be CONSERVATIVE — doing nothing is better',
    'than a risky change no one is watching.',
    '',
    'SCOPE (v1 — SAFE DEAD CODE ONLY): find and remove exactly ONE piece of provably-unused code.',
    'Do NOT refactor, rename, reformat, change behavior, or touch public APIs.',
    focusLine,
    '',
    'SELECTION — use the CODE GRAPH, do not guess:',
    'a. Orient with `project_overview`, then `find_dead_code` to list candidates.',
    'b. Pick the SINGLE safest one (an unexported/unreferenced function, a dead file, an unused',
    '   internal export).',
    'c. PROVE it is safe: run `analyze_impact` / `find_references` on it. It must have ZERO',
    '   references anywhere — including tests, re-exports, and dynamic/string imports. If you',
    '   CANNOT prove zero references, do NOT remove it: choose `blocked` with that reason.',
    'd. Removing it IS your GOAL. Make only that single removal.',
    '',
    ...VERIFIED_PR_PROTOCOL,
  ].join('\n');
}
