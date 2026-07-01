import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildRecipePrompt, isRecipe, RECIPES, parseMaintainScope, MAINTAIN_SCOPES } from '../src/schedule/recipes.js';
import { parseDeliveryTarget, formatRunSummary, clampForPlatform } from '../src/schedule/delivery.js';
import { ScheduleStore } from '../src/schedule/store.js';

describe('recipes — Autonomous Verified PR', () => {
  it('isRecipe accepts known kinds, rejects junk', () => {
    expect(isRecipe('verified-pr')).toBe(true);
    expect(isRecipe('nope')).toBe(false);
    expect(isRecipe(undefined)).toBe(false);
    expect(RECIPES).toContain('verified-pr');
  });

  it('verified-pr wraps the goal in a sandbox→verify→PR-gated protocol', () => {
    const p = buildRecipePrompt('verified-pr', 'fix the flaky auth tests');
    expect(p).toContain('fix the flaky auth tests');
    expect(p).toContain('NEW git branch');
    expect(p).toMatch(/NEVER commit to or push the default branch/i);
    expect(p).toContain('VERIFY');
    expect(p).toContain('create_pr');
    expect(p).toMatch(/DO NOT open a PR/i);          // the failure path is explicit
    expect(p).toContain('VERIFIED-PR: opened');
    expect(p).toContain('VERIFIED-PR: blocked');
  });

  it('no/unknown recipe returns the goal unchanged', () => {
    expect(buildRecipePrompt(undefined, 'just do it')).toBe('just do it');
    expect(buildRecipePrompt('mystery', 'just do it')).toBe('just do it');
  });

  it('maintain is a recipe: conservative dead-code cleanup THROUGH the verified-PR protocol', () => {
    expect(isRecipe('maintain')).toBe(true);
    expect(RECIPES).toContain('maintain');
    const p = buildRecipePrompt('maintain', 'src/utils');
    // code-graph-driven selection
    expect(p).toContain('find_dead_code');
    expect(p).toMatch(/analyze_impact|find_references/);
    expect(p).toMatch(/ZERO references/i);
    expect(p).toMatch(/ONE piece of provably-unused/i); // exactly one, conservative
    expect(p).toMatch(/Do NOT refactor, rename/i);       // strict scope guardrail
    expect(p).toContain('src/utils');                    // focus hint threaded in
    // reuses the verified-PR protocol → still produces a receipt
    expect(p).toContain('VERIFIED-PR: opened');
    expect(p).toContain('```qodex-receipt');
  });

  it('maintain works with no focus hint', () => {
    const p = buildRecipePrompt('maintain', '');
    expect(p).not.toContain('Focus area');
    expect(p).toContain('SAFE DEAD CODE ONLY');
  });

  it('parseMaintainScope: scope keyword, path focus, and --dry-run', () => {
    expect(parseMaintainScope('')).toEqual({ scope: 'dead-code', focus: '', dryRun: false });
    expect(parseMaintainScope('src/utils')).toEqual({ scope: 'dead-code', focus: 'src/utils', dryRun: false });
    expect(parseMaintainScope('unused-imports src/')).toEqual({ scope: 'unused-imports', focus: 'src/', dryRun: false });
    expect(parseMaintainScope('unused-imports --dry-run')).toEqual({ scope: 'unused-imports', focus: '', dryRun: true });
    expect(parseMaintainScope('dead-code --dry-run app/')).toEqual({ scope: 'dead-code', focus: 'app/', dryRun: true });
  });

  it('maintain scope=unused-imports targets only zero-reference bindings, excludes side-effect imports', () => {
    const p = buildRecipePrompt('maintain', 'unused-imports src/');
    expect(p).toContain('UNUSED IMPORTS ONLY');
    expect(p).toMatch(/referenced ZERO times in its own file/i);
    expect(p).toMatch(/NEVER remove a bare `import/i);          // side-effect guardrail
    expect(p).toContain('src/');
    expect(p).toContain('```qodex-receipt');                     // still ships via verified-PR
    expect(p).not.toContain('SAFE DEAD CODE ONLY');              // the other scope is not mixed in
  });

  it('maintain --dry-run previews without modifying or opening a PR', () => {
    const p = buildRecipePrompt('maintain', 'unused-imports --dry-run');
    expect(p).toMatch(/DRY RUN: do NOT modify/i);
    expect(p).toMatch(/blocked — dry-run/i);
  });

  it('maintain scope=unused-locals: excludes params + has a side-effect gate', () => {
    expect(parseMaintainScope('unused-locals src/')).toEqual({ scope: 'unused-locals', focus: 'src/', dryRun: false });
    expect(parseMaintainScope('locals --dry-run')).toEqual({ scope: 'unused-locals', focus: '', dryRun: true });
    const p = buildRecipePrompt('maintain', 'unused-locals');
    expect(p).toContain('UNUSED LOCALS');
    expect(p).toMatch(/EXCLUDE function PARAMETERS/i);     // never remove a param
    expect(p).toMatch(/SIDE-EFFECT GATE/i);                // only side-effect-free initializers
    expect(p).toMatch(/function\/method call, `await`, `new`/i);
    expect(p).toContain('```qodex-receipt');               // still ships via verified-PR
    expect(p).not.toContain('UNUSED IMPORTS ONLY');
  });

  it('maintain scope=unused-params: prefix `_`, NEVER remove, exclude destructured props', () => {
    expect(parseMaintainScope('unused-params src/')).toEqual({ scope: 'unused-params', focus: 'src/', dryRun: false });
    expect(parseMaintainScope('params --dry-run')).toEqual({ scope: 'unused-params', focus: '', dryRun: true });
    const p = buildRecipePrompt('maintain', 'unused-params');
    expect(p).toContain('UNUSED PARAMETERS');
    expect(p).toMatch(/PREFIXING them with an\s*\n?\s*underscore/i);
    expect(p).toMatch(/NEVER remove a parameter/i);          // rename, not remove
    expect(p).toMatch(/EXCLUDE destructured props/i);        // signature-shape guardrail
    expect(p).toContain('```qodex-receipt');                 // still ships via verified-PR
  });

  it('maintain scope=lint-fix: autofixable rules only, focused, no behavior change', () => {
    expect(parseMaintainScope('lint-fix src/')).toEqual({ scope: 'lint-fix', focus: 'src/', dryRun: false });
    expect(parseMaintainScope('lint --dry-run')).toEqual({ scope: 'lint-fix', focus: '', dryRun: true });
    const p = buildRecipePrompt('maintain', 'lint-fix');
    expect(p).toContain('SAFE LINT AUTOFIX');
    expect(p).toMatch(/AUTOFIXABLE rules only/i);
    expect(p).toMatch(/do NOT --fix the whole repo/i);       // bounded, reviewable
    expect(p).toMatch(/never apply a fixer that rewrites logic/i);
    expect(p).toContain('```qodex-receipt');
  });

  it('maintain scope=dep-bump: ONE patch/minor bump, requires tests, never major', () => {
    expect(parseMaintainScope('dep-bump')).toEqual({ scope: 'dep-bump', focus: '', dryRun: false });
    expect(parseMaintainScope('dependencies --dry-run')).toEqual({ scope: 'dep-bump', focus: '', dryRun: true });
    const p = buildRecipePrompt('maintain', 'dep-bump');
    expect(p).toContain('ONE DEPENDENCY BUMP');
    expect(p).toMatch(/NEVER a major version/i);
    expect(p).toMatch(/REQUIRE a real test command/i);       // unverifiable without tests → block
    expect(p).toMatch(/run the FULL test suite/i);
    expect(p).toMatch(/touch no other dependency/i);
  });

  it('maintain scope=consolidate-dupes: exact-duplicate pair only, prove every caller, or block', () => {
    expect(parseMaintainScope('consolidate-dupes src/')).toEqual({ scope: 'consolidate-dupes', focus: 'src/', dryRun: false });
    expect(parseMaintainScope('dupes --dry-run')).toEqual({ scope: 'consolidate-dupes', focus: '', dryRun: true });
    expect(parseMaintainScope('dedupe')).toEqual({ scope: 'consolidate-dupes', focus: '', dryRun: false });
    expect(parseMaintainScope('duplicate util')).toEqual({ scope: 'consolidate-dupes', focus: 'util', dryRun: false });
    const p = buildRecipePrompt('maintain', 'consolidate-dupes');
    expect(p).toContain('CONSOLIDATE ONE PAIR OF DUPLICATE HELPERS');
    expect(p).toMatch(/EXACT-duplicate pair/);
    expect(p).toMatch(/Near-duplicates .* are OUT of scope/i);   // only exact equivalence
    expect(p).toMatch(/enumerate EVERY caller/i);                 // a missed caller breaks the build
    expect(p).toContain('```qodex-receipt');
    expect(MAINTAIN_SCOPES).toEqual(['dead-code', 'unused-imports', 'unused-locals', 'unused-params', 'lint-fix', 'dep-bump', 'consolidate-dupes']);
  });
});

describe('delivery — parse + format', () => {
  it('parses telegram/discord targets, rejects malformed', () => {
    expect(parseDeliveryTarget('telegram:12345')).toEqual({ platform: 'telegram', chatId: '12345' });
    expect(parseDeliveryTarget('  Discord : 99887766 ')).toEqual({ platform: 'discord', chatId: '99887766' });
    expect(parseDeliveryTarget('whatsapp:1')).toBeNull();  // unsupported platform
    expect(parseDeliveryTarget('telegram:')).toBeNull();
    expect(parseDeliveryTarget('')).toBeNull();
    expect(parseDeliveryTarget(undefined)).toBeNull();
  });

  it('formats a success summary and surfaces the VERIFIED-PR verdict from the tail', () => {
    const msg = formatRunSummary({
      name: 'nightly-fix', status: 'success', exitCode: 0, durationSec: 42,
      tail: 'did the thing ... VERIFIED-PR: opened https://github.com/x/y/pull/9', recipe: 'verified-pr',
    });
    expect(msg).toContain('✅');
    expect(msg).toContain('nightly-fix');
    expect(msg).toContain('done in 42s');
    expect(msg).toContain('VERIFIED-PR: opened https://github.com/x/y/pull/9'); // verdict pulled to its own line
  });

  it('formats a failure summary', () => {
    const msg = formatRunSummary({ name: 'job', status: 'error', exitCode: 1, durationSec: 5, tail: 'boom' });
    expect(msg).toContain('❌');
    expect(msg).toContain('error (exit 1) after 5s');
    expect(msg).toContain('boom');
  });

  it('clamps to platform limits', () => {
    const long = 'x'.repeat(5000);
    expect(clampForPlatform(long, 'telegram').length).toBe(4096);
    expect(clampForPlatform(long, 'discord').length).toBe(2000);
    expect(clampForPlatform('short', 'telegram')).toBe('short');
  });
});

describe('store — deliver/recipe persist', () => {
  it('round-trips deliver + recipe through add()/get()', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-'));
    try {
      const store = new ScheduleStore(path.join(dir, 's.db'));
      const e = store.add({
        name: 'verified-nightly', cron: '@daily', prompt: 'tidy the lint', cwd: dir,
        deliver: 'telegram:555', recipe: 'verified-pr',
      });
      const got = store.get(e.id)!;
      expect(got.deliver).toBe('telegram:555');
      expect(got.recipe).toBe('verified-pr');
      // a plain task leaves them null
      const plain = store.add({ name: 'plain', cron: '@hourly', prompt: 'p', cwd: dir });
      expect(store.get(plain.id)!.deliver ?? null).toBeNull();
      expect(store.get(plain.id)!.recipe ?? null).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
