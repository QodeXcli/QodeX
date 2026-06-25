import { describe, it, expect } from 'vitest';
import {
  extractOriginalPrompt, skillContentHash, formatEvalSection, upsertEvalSection,
  shouldSkipEval, deriveStatus, type EvalResult,
} from '../src/skills/learning/eval-record.js';

const SKILL = `---
name: add-pagination
description: Add cursor pagination
provenance: machine
status: candidate
---

# add-pagination

## When to use
Add pagination.

## Original request
Add cursor-based pagination to the /users endpoint with a limit and next-cursor.

## Approach that worked
Parse limit + cursor, fetch limit+1, return next-cursor.
`;

const RESULT: EvalResult = { status: 'pass', checker: 'tsc', errorCount: 0, filesChanged: 2, model: 'judge-x', at: '2026-06-25T00:00:00.000Z' };

describe('eval-record — extract + format + upsert', () => {
  it('extracts the original task prompt', () => {
    expect(extractOriginalPrompt(SKILL)).toBe('Add cursor-based pagination to the /users endpoint with a limit and next-cursor.');
    expect(extractOriginalPrompt('# no sections')).toBeNull();
  });
  it('formats a readable section with status + hash', () => {
    const s = formatEvalSection(RESULT, 'abc123');
    expect(s).toContain('## Auto-evaluation');
    expect(s).toContain('- status: pass');
    expect(s).toContain('- content-hash: abc123');
  });
  it('upsert appends when absent and REPLACES when present (no duplicate section)', () => {
    const once = upsertEvalSection(SKILL, formatEvalSection(RESULT, skillContentHash(SKILL)));
    expect((once.match(/## Auto-evaluation/g) ?? []).length).toBe(1);
    const twice = upsertEvalSection(once, formatEvalSection({ ...RESULT, status: 'fail' }, skillContentHash(once)));
    expect((twice.match(/## Auto-evaluation/g) ?? []).length).toBe(1); // still ONE
    expect(twice).toContain('- status: fail');
  });
});

describe('eval-record — content hash is stable across the eval result', () => {
  it('writing an eval section does NOT change the content hash', () => {
    const h0 = skillContentHash(SKILL);
    const withEval = upsertEvalSection(SKILL, formatEvalSection(RESULT, h0));
    expect(skillContentHash(withEval)).toBe(h0); // eval section excluded from the hash
  });
  it('editing the skill body DOES change the hash', () => {
    const edited = SKILL.replace('Parse limit + cursor', 'Parse limit + cursor + sort key');
    expect(skillContentHash(edited)).not.toBe(skillContentHash(SKILL));
  });
});

describe('eval-record — cache (shouldSkipEval)', () => {
  const now = Date.parse('2026-06-25T12:00:00.000Z');
  it('skips when unchanged and within TTL', () => {
    const withEval = upsertEvalSection(SKILL, formatEvalSection({ ...RESULT, at: '2026-06-25T11:00:00.000Z' }, skillContentHash(SKILL)));
    expect(shouldSkipEval(withEval, 24 * 3600_000, now).skip).toBe(true);   // 1h ago
    expect(shouldSkipEval(withEval, 30 * 60_000, now).skip).toBe(false);    // TTL 30m → elapsed
  });
  it('does not skip a never-evaluated or changed skill', () => {
    expect(shouldSkipEval(SKILL, 24 * 3600_000, now).skip).toBe(false);
  });
});

describe('eval-record — deriveStatus', () => {
  it('no files → inconclusive; checker clean → pass; errors → fail; no checker → inconclusive', () => {
    expect(deriveStatus(0, true, 0)).toBe('inconclusive');
    expect(deriveStatus(2, true, 0)).toBe('pass');
    expect(deriveStatus(2, true, 3)).toBe('fail');
    expect(deriveStatus(2, false, 0)).toBe('inconclusive');
  });
});
