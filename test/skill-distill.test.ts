/**
 * Flywheel phase 1 — distill a successful session into a reviewable DRAFT skill.
 *
 * Covers the four guarantees of the MVP:
 *   1. A plausible session distills into a draft with a collapsed step outline + evidence.
 *   2. Trivial sessions (too few steps / no changed files) are skipped — distillDraft
 *      returns null so the caller falls back to the minimal capture.
 *   3. The draft round-trips through the EXISTING candidate store byte-identically, and
 *      the listing surfaces the richer step/evidence counts for the dashboard.
 *   4. The phase-2 eval hook is an honest stub: score null + the labeled note.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  collapseToolSequence,
  distillDraft,
  triggerFromPrompt,
  evalCandidate,
  type SessionDigest,
} from '../src/skills/learning/distill.js';

const plausible: SessionDigest = {
  prompt: 'Add retry with exponential backoff to the HTTP client',
  finalSummary: 'Added a retry wrapper with jittered exponential backoff and covered it with unit tests.',
  toolSequence: ['glob', 'read_file', 'read_file', 'grep', 'edit_text', 'shell', 'shell'],
  filesChanged: ['src/http/client.ts', 'test/http-client.test.ts'],
};

describe('collapseToolSequence — ordered runs, not a distinct set', () => {
  it('merges consecutive repeats and preserves order', () => {
    expect(collapseToolSequence(plausible.toolSequence)).toEqual([
      { tool: 'glob', count: 1 },
      { tool: 'read_file', count: 2 },
      { tool: 'grep', count: 1 },
      { tool: 'edit_text', count: 1 },
      { tool: 'shell', count: 2 },
    ]);
  });
  it('does NOT merge non-consecutive repeats (the return to a tool is a real step)', () => {
    expect(collapseToolSequence(['read_file', 'shell', 'read_file'])).toHaveLength(3);
  });
  it('empty sequence → empty outline', () => {
    expect(collapseToolSequence([])).toEqual([]);
  });
});

describe('distillDraft — deterministic draft from session signals', () => {
  it('distills a plausible session into a draft with steps + evidence', () => {
    const draft = distillDraft(plausible, { nowIso: '2026-07-11T00:00:00Z', confidence: 82 });
    expect(draft).not.toBeNull();
    expect(draft!.name).toBe('add-retry-with-exponential-backoff');
    expect(draft!.steps).toHaveLength(5);
    expect(draft!.evidence.files).toEqual(plausible.filesChanged);
    expect(draft!.evidence.tools).toContain('edit_text');
    expect(draft!.trigger).toContain('Add retry with exponential backoff');
    // The SKILL.md carries the quarantine stamps + the structured draft frontmatter.
    expect(draft!.skillMd).toContain('provenance: machine');
    expect(draft!.skillMd).toContain('status: candidate');
    expect(draft!.skillMd).toContain('draft: flywheel-v1');
    expect(draft!.skillMd).toContain('steps: 5');
    expect(draft!.skillMd).toContain('confidence: 82');
    expect(draft!.skillMd).toContain('## Step outline');
    expect(draft!.skillMd).toContain('`read_file` ×2');
    expect(draft!.skillMd).toContain('- src/http/client.ts');
  });
  it('is deterministic — same digest, same draft', () => {
    const a = distillDraft(plausible, { nowIso: 'T' });
    const b = distillDraft(plausible, { nowIso: 'T' });
    expect(a!.skillMd).toBe(b!.skillMd);
  });
  it('skips a session with too few collapsed steps (trivial)', () => {
    expect(distillDraft({ ...plausible, toolSequence: ['read_file', 'edit_text'] }, { nowIso: 'T' })).toBeNull();
    // Many calls but ONE collapsed run is still trivial — no procedure shape.
    expect(distillDraft({ ...plausible, toolSequence: ['shell', 'shell', 'shell', 'shell'] }, { nowIso: 'T' })).toBeNull();
  });
  it('skips a session that changed no files (no evidence to anchor)', () => {
    expect(distillDraft({ ...plausible, filesChanged: [] }, { nowIso: 'T' })).toBeNull();
  });
  it('truncates marathon sequences with an explicit marker', () => {
    const long = Array.from({ length: 40 }, (_, i) => `tool_${i}`); // 40 distinct → 40 steps
    const draft = distillDraft({ ...plausible, toolSequence: long }, { nowIso: 'T' });
    expect(draft!.steps).toHaveLength(12); // DEFAULT_DISTILL_POLICY.maxSteps
    expect(draft!.skillMd).toContain('plus 28 more steps (sequence truncated)');
  });
  it('trigger derives from the first prompt line, clipped', () => {
    expect(triggerFromPrompt('fix the bug\nlong details here')).toBe('Use when the task resembles: fix the bug');
    expect(triggerFromPrompt('x'.repeat(200))).toHaveLength('Use when the task resembles: '.length + 138); // 137 chars + '…'
  });
});

describe('draft round-trips through the existing candidate store', () => {
  let tmpHome: string;
  let origHome: string | undefined;
  beforeAll(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-distill-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome; // os.homedir() reads $HOME on posix
  });
  afterAll(async () => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('write → read is byte-identical; listing surfaces steps + evidence', async () => {
    const { writeCandidate, readCandidate, listCandidates } = await import('../src/skills/learning/candidate-store.js');
    const draft = distillDraft(plausible, { nowIso: '2026-07-11T00:00:00Z', confidence: 77 })!;
    const file = await writeCandidate(draft);
    expect(file).toContain(path.join('.qodex', 'skills-candidates', draft.name));
    expect(await readCandidate(draft.name)).toBe(draft.skillMd);
    const listed = (await listCandidates()).find(c => c.name === draft.name);
    expect(listed).toBeDefined();
    expect(listed!.steps).toBe(5);
    expect(listed!.evidence).toBe(draft.evidence.files.length + draft.evidence.tools.length);
    expect(listed!.confidence).toBe(77);
    expect(listed!.description).toBe(draft.description);
  });
});

describe('evalCandidate — honest phase-2 stub', () => {
  it('returns no score and the clearly-labeled note', () => {
    const draft = distillDraft(plausible, { nowIso: 'T' })!;
    expect(evalCandidate(draft)).toEqual({ score: null, note: 'eval-gated promotion lands in phase 2' });
  });
});
