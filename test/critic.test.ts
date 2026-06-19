import { describe, it, expect } from 'vitest';
import { buildCriticPrompt, parseCriticVerdict, buildCriticRepairMessage } from '../src/agent/critic.js';

describe('parseCriticVerdict', () => {
  it('parses a clean pass', () => {
    const v = parseCriticVerdict('{"pass": true, "findings": []}');
    expect(v.pass).toBe(true);
    expect(v.findings).toHaveLength(0);
  });

  it('parses blocking findings and sets pass=false', () => {
    const v = parseCriticVerdict(
      '{"pass": false, "findings": [{"severity":"blocker","location":"a.ts:10","issue":"off-by-one"}]}',
    );
    expect(v.pass).toBe(false);
    expect(v.findings[0].severity).toBe('blocker');
    expect(v.findings[0].location).toBe('a.ts:10');
  });

  it('infers pass=false when a blocker exists even if pass field omitted', () => {
    const v = parseCriticVerdict('{"findings":[{"severity":"blocker","issue":"x"}]}');
    expect(v.pass).toBe(false);
  });

  it('treats warnings-only as a pass', () => {
    const v = parseCriticVerdict('{"pass":true,"findings":[{"severity":"warning","issue":"style"}]}');
    expect(v.pass).toBe(true);
  });

  it('tolerates fenced JSON', () => {
    const v = parseCriticVerdict('```json\n{"pass": true, "findings": []}\n```');
    expect(v.pass).toBe(true);
  });

  it('fails OPEN (pass=true) when the verdict is unparseable', () => {
    const v = parseCriticVerdict('the code looks fine to me, no issues');
    expect(v.pass).toBe(true);
    expect(v.raw).toBeTruthy();
  });
});

describe('buildCriticPrompt', () => {
  it('includes the task, file content, and spec when provided', () => {
    const { system, user } = buildCriticPrompt({
      task: 'add login',
      files: [{ path: 'auth.ts', content: 'export function login() {}' }],
      specBlock: 'Always validate inputs.',
    });
    expect(system).toMatch(/QA Engineer/);
    expect(user).toMatch(/add login/);
    expect(user).toMatch(/auth\.ts/);
    expect(user).toMatch(/Always validate inputs/);
  });
});

describe('buildCriticRepairMessage', () => {
  it('lists only blocking findings', () => {
    const msg = buildCriticRepairMessage({
      pass: false,
      findings: [
        { severity: 'blocker', location: 'a.ts:1', issue: 'null deref' },
        { severity: 'warning', issue: 'naming' },
      ],
    });
    expect(msg).toMatch(/null deref/);
    expect(msg).not.toMatch(/naming/);
    expect(msg).toMatch(/QA REVIEW/);
  });
});
