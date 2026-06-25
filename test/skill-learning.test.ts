import { describe, it, expect } from 'vitest';
import { isProtected, isMachineOwned, canMachineWrite } from '../src/skills/provenance.js';
import { captureEligible, buildCandidateSkill, skillIdFromPrompt, DEFAULT_CAPTURE_POLICY } from '../src/skills/learning/capture.js';
import { decidePromotion } from '../src/skills/learning/promotion.js';
import { parseJudgeVerdict } from '../src/skills/learning/judge.js';
import { parseSkill } from '../src/skills/loader.js';

describe('loader — provenance/status frontmatter parsing (protection data source)', () => {
  const mk = (fm: string) => parseSkill(`---\nname: s\ndescription: d\n${fm}\n---\nbody`, 's', '/tmp/s', 'user');
  it('absent provenance defaults to user (protected) and active', () => {
    const s = mk('')!;
    expect(s.provenance).toBe('user');
    expect(s.status).toBe('active');
    expect(s.humanEdited).toBe(false);
  });
  it('reads provenance:machine, status:candidate, humanEdited:true', () => {
    expect(mk('provenance: machine')!.provenance).toBe('machine');
    expect(mk('status: candidate')!.status).toBe('candidate');
    expect(mk('humanEdited: true')!.humanEdited).toBe(true);
  });
});

describe('provenance — human skills are immutable to the machine', () => {
  it('treats absent/explicit-user provenance as PROTECTED (default-safe)', () => {
    expect(isProtected(undefined)).toBe(false);           // nothing to protect
    expect(isProtected({})).toBe(true);                   // legacy/absent → protected
    expect(isProtected({ provenance: 'user' })).toBe(true);
    expect(isProtected({ provenance: 'machine' })).toBe(false);
  });
  it('a human edit promotes a machine skill to protected', () => {
    expect(isProtected({ provenance: 'machine', humanEdited: true })).toBe(true);
    expect(isMachineOwned({ provenance: 'machine' })).toBe(true);
    expect(isMachineOwned({ provenance: 'machine', humanEdited: true })).toBe(false);
  });
  it('canMachineWrite: allows fresh + machine-owned, DENIES human-protected', () => {
    expect(canMachineWrite('x', null).allowed).toBe(true);                         // fresh
    expect(canMachineWrite('x', { provenance: 'machine' }).allowed).toBe(true);    // curate own capture
    expect(canMachineWrite('x', { provenance: 'user' }).allowed).toBe(false);      // human → refuse
    expect(canMachineWrite('x', {}).allowed).toBe(false);                          // legacy → refuse
    expect(canMachineWrite('x', { provenance: 'machine', humanEdited: true }).allowed).toBe(false);
  });
});

describe('captureEligible — OBJECTIVE gate, never a self-grade', () => {
  const ok = { toolCalls: 6, verifyClean: true, completionHonest: true, toolsUsed: ['edit_text'], filesChanged: ['a.ts'] };
  it('eligible only when verified, honest, and non-trivial', () => {
    expect(captureEligible(ok).eligible).toBe(true);
  });
  it('rejects trivial tasks (below minToolCalls)', () => {
    expect(captureEligible({ ...ok, toolCalls: 2 }).eligible).toBe(false);
  });
  it('rejects tasks that did NOT objectively verify', () => {
    expect(captureEligible({ ...ok, verifyClean: false }).eligible).toBe(false);
    expect(captureEligible({ ...ok, completionHonest: false }).eligible).toBe(false);
  });
  it('requireObjectiveSuccess:false bypasses the objective gate (loud opt-out)', () => {
    const policy = { ...DEFAULT_CAPTURE_POLICY, requireObjectiveSuccess: false };
    expect(captureEligible({ ...ok, verifyClean: false, completionHonest: false }, policy).eligible).toBe(true);
  });
});

describe('buildCandidateSkill — quarantined by construction', () => {
  const traj = { prompt: 'Add a retry wrapper to the HTTP client', finalSummary: 'Wrapped fetch with exponential backoff', toolsUsed: ['read_file', 'edit_text', 'shell'], filesChanged: ['src/http.ts'] };
  it('stamps provenance:machine and status:candidate', () => {
    const c = buildCandidateSkill(traj, { nowIso: '2026-06-25T00:00:00Z' });
    expect(c.skillMd).toContain('provenance: machine');
    expect(c.skillMd).toContain('status: candidate');
    expect(c.name).toBe('add-a-retry-wrapper-to');
    expect(c.skillMd).toContain('read_file');
    expect(c.skillMd).toContain('src/http.ts');
  });
  it('honors a valid name override and falls back otherwise', () => {
    expect(buildCandidateSkill(traj, { name: 'http-retry', nowIso: '' }).name).toBe('http-retry');
    expect(buildCandidateSkill(traj, { name: 'Bad Name!', nowIso: '' }).name).toBe('add-a-retry-wrapper-to'); // invalid → derived
  });
  it('skillIdFromPrompt is kebab, bounded, and never empty (Persian → fallback)', () => {
    expect(skillIdFromPrompt('Fix the Login Bug now please')).toBe('fix-the-login-bug-now');
    expect(skillIdFromPrompt('باگ ورود را درست کن')).toBe('captured-skill'); // non-ascii → safe fallback
  });
});

describe('decidePromotion — independent judge + human-protection (the crux)', () => {
  const author = 'qwen2.5-coder:32b';
  const goodVerdict = { pass: true, judgeModel: 'qwen2.5-coder:7b', reasons: ['reusable'] };

  it('refuses promotion with NO judge verdict (self-grade never accepted)', () => {
    expect(decidePromotion({ authorModel: author, verdict: null }).promote).toBe(false);
  });
  it('refuses when the judge model EQUALS the author model (self-grade)', () => {
    const v = { pass: true, judgeModel: author, reasons: [] };
    expect(decidePromotion({ authorModel: author, verdict: v }).promote).toBe(false);
  });
  it('refuses when the independent judge rejects', () => {
    const v = { pass: false, judgeModel: 'other-model', reasons: ['redundant'] };
    expect(decidePromotion({ authorModel: author, verdict: v }).promote).toBe(false);
  });
  it('refuses to overwrite a human-authored active skill of the same name', () => {
    const d = decidePromotion({ authorModel: author, verdict: goodVerdict, activeSameName: { provenance: 'user' } });
    expect(d.promote).toBe(false);
    expect(d.reason).toMatch(/human-authored/);
  });
  it('PROMOTES with an independent passing judge and no protected blocker', () => {
    expect(decidePromotion({ authorModel: author, verdict: goodVerdict, activeSameName: null }).promote).toBe(true);
    // a prior machine capture of the same name MAY be replaced
    expect(decidePromotion({ authorModel: author, verdict: goodVerdict, activeSameName: { provenance: 'machine' } }).promote).toBe(true);
  });
});

describe('parseJudgeVerdict — fails CLOSED (unknown ⇒ reject)', () => {
  it('parses a clean verdict and stamps the judge model', () => {
    const v = parseJudgeVerdict('{"pass": true, "reasons": ["good"]}', 'judge-x');
    expect(v).toEqual({ pass: true, judgeModel: 'judge-x', reasons: ['good'] });
  });
  it('an unparseable response is a REJECT, not a pass', () => {
    expect(parseJudgeVerdict('the skill looks fine to me!', 'judge-x').pass).toBe(false);
  });
});
