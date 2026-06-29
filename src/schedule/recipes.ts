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

export const RECIPES = ['verified-pr'] as const;
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
  return goal;
}

function verifiedPrPrompt(goal: string): string {
  return [
    'You are running UNATTENDED on a schedule — no human is watching this run. Follow this',
    'protocol EXACTLY and do not deviate from it.',
    '',
    `GOAL: ${goal.trim()}`,
    '',
    'PROTOCOL — Autonomous Verified PR:',
    '1. Create a NEW git branch (e.g. `qodex/auto/<short-slug>`) off the current branch and do',
    '   ALL work there. NEVER commit to or push the default branch (main/master) directly.',
    '2. Make the changes the GOAL requires.',
    '3. VERIFY before claiming anything: run the project\'s test command and the type/lint',
    '   checkers on the files you changed. If there is no test command, at minimum run the',
    '   language verifier (tsc / ruff / go vet / …) on every file you touched.',
    '4. DECISION GATE — mandatory:',
    '   • If verification PASSES: commit, push the branch, and open a pull request with the',
    '     `create_pr` tool. Put what you changed AND the real verification output in the PR body.',
    '   • If verification FAILS, or you are not certain it passed: DO NOT open a PR and DO NOT',
    '     claim success. Leave the branch as-is for a human, and report exactly what failed.',
    '5. End with ONE final status line and nothing after it:',
    '   • `VERIFIED-PR: opened <pr-url>`            — only if you actually opened a PR, or',
    '   • `VERIFIED-PR: blocked — <one-line reason>` — if you did not.',
    '',
    'Honesty rule: a green status you cannot back with real verification output is a FAILURE,',
    'not a success. When in doubt, choose `blocked`.',
  ].join('\n');
}
