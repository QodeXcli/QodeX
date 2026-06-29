import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildRecipePrompt, isRecipe, RECIPES } from '../src/schedule/recipes.js';
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
