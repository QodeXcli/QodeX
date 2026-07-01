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

/** The self-improving `maintain` recipe has SCOPES — each a conservative, provable cleanup. */
export type MaintainScope = 'dead-code' | 'unused-imports' | 'unused-locals' | 'unused-params' | 'lint-fix' | 'dep-bump' | 'consolidate-dupes';
export const MAINTAIN_SCOPES: readonly MaintainScope[] = ['dead-code', 'unused-imports', 'unused-locals', 'unused-params', 'lint-fix', 'dep-bump', 'consolidate-dupes'] as const;

/** Parse a maintain prompt into its scope + optional path focus + dry-run flag. PURE.
 *  Forms: "" (→ dead-code) · "unused-imports src/" · "lint-fix --dry-run" · "dep-bump" · "src/utils". */
export function parseMaintainScope(prompt: string): { scope: MaintainScope; focus: string; dryRun: boolean } {
  let rest = (prompt ?? '').trim();
  const dryRun = /(^|\s)(--dry-run|dry-run)(\s|$)/i.test(rest);
  rest = rest.replace(/(^|\s)(--dry-run|dry-run)(\s|$)/ig, ' ').trim();
  let scope: MaintainScope = 'dead-code';
  const m = /^(unused[-_]?imports|imports|unused[-_]?locals|locals|unused[-_]?params|params|lint[-_]?fix|lint|dep[-_]?bump|deps?|dependenc(?:y|ies)|consolidate[-_]?dupes?|consolidate|duplicates?|dupes?|dedupe|dead[-_]?code)\b/i.exec(rest);
  if (m) {
    const k = m[1]!;
    scope = /imports/i.test(k) ? 'unused-imports'
      : /locals/i.test(k) ? 'unused-locals'
      : /params/i.test(k) ? 'unused-params'
      : /lint/i.test(k) ? 'lint-fix'
      : /dep/i.test(k) ? 'dep-bump'
      : /consolidate|duplicate|dupe|dedupe/i.test(k) ? 'consolidate-dupes'
      : 'dead-code';
    rest = rest.slice(m[0].length).trim();
  }
  return { scope, focus: rest, dryRun };
}

const DEAD_CODE_SELECTION = [
  'SCOPE (v1 — SAFE DEAD CODE ONLY): find and remove exactly ONE piece of provably-unused code.',
  '',
  'SELECTION — use the CODE GRAPH, do not guess:',
  'a. Orient with `project_overview`, then `find_dead_code` to list candidates.',
  'b. Pick the SINGLE safest one (an unexported/unreferenced function, a dead file, an unused',
  '   internal export).',
  'c. PROVE it is safe: run `analyze_impact` / `find_references` on it. It must have ZERO',
  '   references anywhere — including tests, re-exports, and dynamic/string imports. If you',
  '   CANNOT prove zero references, do NOT remove it: choose `blocked` with that reason.',
  'd. Removing it IS your GOAL. Make only that single removal.',
];

const UNUSED_IMPORTS_SELECTION = [
  'SCOPE (v2 — UNUSED IMPORTS ONLY): remove import bindings that are referenced ZERO times in the',
  'file that imports them.',
  '',
  'SELECTION — prove unused with the toolchain, do not guess:',
  'a. Find unused imports — run the project linter / type-checker (eslint, ruff, or',
  '   `tsc --noUnusedLocals`), or `find_references` on each imported binding. A binding is',
  '   removable ONLY if it is referenced ZERO times in its own file.',
  'b. EXCLUDE side-effect imports — NEVER remove a bare `import "x"` / `import "./styles.css"`:',
  '   those run for effect, not a binding.',
  'c. Remove only the unused bindings (drop the whole import line if it becomes empty). Touch',
  '   nothing else — no reordering, no reformatting of used imports.',
  'd. Removing them IS your GOAL.',
];

const UNUSED_LOCALS_SELECTION = [
  'SCOPE (v3 — UNUSED LOCALS, with EXTRA caution): remove local/module bindings (const/let) that',
  'are declared but referenced ZERO times.',
  '',
  'SELECTION — prove unused AND side-effect-free, or block:',
  'a. Find candidates with the type-checker (`tsc --noUnusedLocals`, or the linter\'s no-unused-vars),',
  '   or `find_references`. The binding must be referenced ZERO times.',
  'b. EXCLUDE function PARAMETERS entirely — never remove a parameter (it may be required by a',
  '   signature/interface, or sit in the middle of the list). If the only fix is a param, BLOCK.',
  'c. SIDE-EFFECT GATE (critical): only remove a binding whose initializer is provably side-effect-',
  '   free — a literal, regex, array/object literal, or a pure expression. If the right-hand side',
  '   has ANY function/method call, `await`, `new`, or could trigger a getter, DO NOT remove it',
  '   (its effect may matter even though the value is unused): choose `blocked` with that reason.',
  'd. Remove only the proven-safe bindings. Touch nothing else.',
];

const UNUSED_PARAMS_SELECTION = [
  'SCOPE (v4 — UNUSED PARAMETERS): silence unused function parameters by PREFIXING them with an',
  'underscore (`foo` → `_foo`). NEVER remove a parameter — that would change the signature/arity',
  'and break callers. The `_` prefix is the convention tsc (`noUnusedParameters`) and eslint',
  '(`argsIgnorePattern: ^_`) already ignore, so it removes the warning with ZERO behavior change.',
  '',
  'SELECTION — prove unused, rename only:',
  'a. Find unused parameters with `tsc --noUnusedParameters` or the linter. The parameter must be',
  '   referenced ZERO times in its function body.',
  'b. For a simple positional parameter `foo`, rename it to `_foo` AT ITS DECLARATION only.',
  'c. EXCLUDE destructured props (`{ x }`) and already-`_`-prefixed params — renaming a destructured',
  '   prop changes the object shape callers pass. If the only fix is a destructured prop, BLOCK.',
  'd. The `_`-prefix is your GOAL. Change nothing else.',
];

const LINT_FIX_SELECTION = [
  'SCOPE (v5 — SAFE LINT AUTOFIX): apply the project linter\'s AUTOFIXABLE rules only — the',
  'mechanical fixes (`eslint --fix`, `ruff check --fix`, `gofmt`). No manual edits, no rule whose',
  'fix could change behavior.',
  '',
  'SELECTION — autofix, then prove nothing broke:',
  'a. Detect the linter from the project (eslint / ruff / biome …). If there is none, BLOCK.',
  'b. Run its autofix on the focus area only (a dir/file you were given, else a small bounded set —',
  '   do NOT --fix the whole repo in one shot).',
  'c. Restrict to AUTOFIXABLE rules. Never apply a fixer that rewrites logic (e.g. no-unsafe-*,',
  '   prefer-const on exported API). If a fix is semantic or you are unsure, leave it.',
  'd. The autofix diff IS your GOAL. Keep it small and reviewable.',
];

const DEP_BUMP_SELECTION = [
  'SCOPE (v6 — ONE DEPENDENCY BUMP, test-verified): bump exactly ONE dependency to a newer PATCH',
  'or MINOR version and prove the tests still pass. NEVER a major version (breaking changes).',
  '',
  'SELECTION — one safe bump, proven by the suite:',
  'a. REQUIRE a real test command (npm test / pytest / go test …). If the project has no tests,',
  '   BLOCK — a dep bump without tests is unverifiable.',
  'b. List outdated deps (`npm outdated` / equivalent). Pick ONE with a patch/minor update only.',
  '   Skip anything whose new major differs, and skip pinned/peer-critical deps if unsure.',
  'c. Update that one version in the manifest, install, and run the FULL test suite.',
  'd. If the suite passes it ships; if anything fails, BLOCK and report (do not "fix" the dep).',
  'e. The single version bump IS your GOAL — touch no other dependency.',
];

const CONSOLIDATE_DUPES_SELECTION = [
  'SCOPE (v7 — CONSOLIDATE ONE PAIR OF DUPLICATE HELPERS): find TWO functions whose bodies are',
  'EXACTLY equivalent and remove ONE by pointing its callers at the other. This is the code-graph',
  'scope — a plain agent cannot prove two functions are equivalent, nor find every caller, so it',
  'CANNOT do this safely. You can. Be extremely conservative: a missed caller breaks the build.',
  '',
  'SELECTION — prove exact-duplicate AND prove every caller, or block:',
  'a. Use the code graph to find an EXACT-duplicate pair: normalized bodies identical (ignore only',
  '   whitespace/comments) AND identical parameter list and return shape. If you are not CERTAIN they',
  '   are behaviorally identical, BLOCK. Near-duplicates / "similar" functions are OUT of scope.',
  'b. Both must be self-contained helpers — no differing captured closure variables, no distinct',
  '   module-level side effects, no reliance on differing imports. If either captures different outer',
  '   scope, BLOCK. Pick the canonical one to KEEP (prefer the exported / more central / better-named).',
  'c. With `find_references` / `analyze_impact`, enumerate EVERY caller of the one to remove. If ANY',
  '   reference is dynamic/string-based, re-exported, or you cannot resolve them all, BLOCK.',
  'd. Repoint each caller to the canonical function (add an import only if needed), then delete the',
  '   duplicate. Change ONLY what the repoint requires — no renames, no reordering, no behavior tweaks.',
  'e. This single consolidation IS your GOAL. Verification (tests + types) MUST pass or it does not ship.',
];

/**
 * `maintain` — the self-improving codebase recipe. Each scope is the SAFEST improvement of its
 * kind, proven (code-graph / toolchain) and shipped through the verified-PR protocol. Conservative
 * by design — a wrong "improvement" at 3am is worse than none — so it must PROVE safety or block.
 * `--dry-run` previews candidates without changing anything (always blocks).
 */
function maintainPrompt(prompt: string): string {
  const { scope, focus, dryRun } = parseMaintainScope(prompt);
  const selection = scope === 'unused-imports' ? UNUSED_IMPORTS_SELECTION
    : scope === 'unused-locals' ? UNUSED_LOCALS_SELECTION
    : scope === 'unused-params' ? UNUSED_PARAMS_SELECTION
    : scope === 'lint-fix' ? LINT_FIX_SELECTION
    : scope === 'dep-bump' ? DEP_BUMP_SELECTION
    : scope === 'consolidate-dupes' ? CONSOLIDATE_DUPES_SELECTION
    : DEAD_CODE_SELECTION;
  const focusLine = focus ? `Focus area (optional hint): ${focus}.` : '';
  const dryRunBlock = dryRun ? [
    '',
    'DRY RUN: do NOT modify any files and do NOT open a PR. Identify the candidates you WOULD',
    'remove, then end with `VERIFIED-PR: blocked — dry-run: <n> candidate(s)` and a receipt',
    '(status blocked) whose summary lists them. Preview only.',
  ] : [];
  return [
    ...UNATTENDED_HEADER,
    '',
    'ROLE: you are a nightly code-maintenance agent. Be CONSERVATIVE — doing nothing is better',
    'than a risky change no one is watching.',
    'Do NOT refactor, rename, reformat, change behavior, or touch public APIs.',
    focusLine,
    ...dryRunBlock,
    '',
    ...selection,
    '',
    ...VERIFIED_PR_PROTOCOL,
  ].join('\n');
}
