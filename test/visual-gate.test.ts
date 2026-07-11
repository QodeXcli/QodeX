/**
 * Tests for src/agent/visual-gate.ts (completion-time visual verification gate).
 * The review is a mocked VisualReviewFn — no browser, no vision model, no loop.
 * Run: npx tsx test/visual-gate.test.ts
 */
import {
  findLatestSessionArtifact,
  buildVisualCorrection,
  runVisualGate,
  type VisualReviewOutcome,
} from '../src/agent/visual-gate.ts';
import type { MsgLike } from '../src/agent/completion-gate.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const created = (id: string): MsgLike =>
  ({ role: 'tool', name: 'artifact_create', content: `Created artifact "${id}" (html, v1) at /tmp/x/index.html. Use artifact_update with id="${id}" to revise it.` });
const updated = (id: string, v = 2): MsgLike =>
  ({ role: 'tool', name: 'artifact_update', content: `Saved "${id}" v${v} at /tmp/x/index.html. It now has ${v} version(s).` });
const createErr: MsgLike =
  { role: 'tool', name: 'artifact_create', content: 'Invalid artifact type "exe". Use one of: html, react, svg, markdown, vue, text.' };
const chatter: MsgLike[] = [
  { role: 'user', content: 'make me a pricing page' },
  { role: 'assistant', content: 'On it.' },
  { role: 'tool', name: 'read_file', content: 'Created artifact "decoy" — (this is file content, wrong tool name, must not match)' },
];

/** A reviewFn that returns queued outcomes and counts its calls. */
function mockReview(...outcomes: VisualReviewOutcome[]) {
  const calls: string[] = [];
  const queue = [...outcomes];
  const fn = async (id: string) => {
    calls.push(id);
    const next = queue.shift();
    if (!next) throw new Error('mock reviewFn called more times than outcomes queued');
    return next;
  };
  return { fn, calls };
}

console.log('— findLatestSessionArtifact —');
{
  check('no artifacts → null', findLatestSessionArtifact(chatter) === null);
  check('artifact_create is found', findLatestSessionArtifact([...chatter, created('pricing-page')]) === 'pricing-page');
  check('artifact_update is found', findLatestSessionArtifact([updated('dash')]) === 'dash');
  check('latest touch wins', findLatestSessionArtifact([created('a'), created('b'), updated('a')]) === 'a');
  check('failed create is ignored', findLatestSessionArtifact([createErr]) === null);
  check('non-string tool content is ignored', findLatestSessionArtifact([{ role: 'tool', name: 'artifact_create', content: { odd: true } }]) === null);
}

console.log('— gate off / nothing to review —');
{
  const disabled = mockReview();
  const r1 = await runVisualGate({ messages: [created('x')], enabled: false, retriedAlready: false, reviewFn: disabled.fn });
  check('config off → skipped', r1.action === 'skip');
  check('config off → review never runs', disabled.calls.length === 0);

  const noArt = mockReview();
  const r2 = await runVisualGate({ messages: chatter, enabled: true, retriedAlready: false, reviewFn: noArt.fn });
  check('no artifacts this session → skipped', r2.action === 'skip');
  check('no artifacts → review never runs', noArt.calls.length === 0);
}

console.log('— LOOKS_GOOD → pass —');
{
  const m = mockReview({ verdict: 'looks_good', issues: [] });
  const r = await runVisualGate({ messages: [created('hero')], enabled: true, retriedAlready: false, reviewFn: m.fn });
  check('passes', r.action === 'pass');
  check('reviewed the right artifact', m.calls.length === 1 && m.calls[0] === 'hero');
  check('verdict line says LOOKS_GOOD', !!r.verdictLine && r.verdictLine.includes('LOOKS_GOOD'));
  check('verdict line is the 👁 surface', !!r.verdictLine && r.verdictLine.startsWith('👁 visual check:'));
}

console.log('— NEEDS_WORK → exactly one retry, then warning-pass —');
{
  // First finish attempt: retry budget unspent → bounce back with the issues.
  const m1 = mockReview({ verdict: 'needs_work', issues: ['button overlaps the header', 'footer cut off'] });
  const r1 = await runVisualGate({ messages: [created('hero')], enabled: true, retriedAlready: false, reviewFn: m1.fn });
  check('first bad verdict → retry', r1.action === 'retry');
  check('correction carries the marker', !!r1.correction && r1.correction.includes('[VISUAL_GATE]'));
  check('correction lists the issues', !!r1.correction && r1.correction.includes('button overlaps the header'));
  check('correction says how to fix', !!r1.correction && r1.correction.includes('artifact_update id="hero"'));
  check('review ran exactly once', m1.calls.length === 1);

  // Second finish attempt (after the model tried a fix): budget spent → warning-pass, never a loop.
  const m2 = mockReview({ verdict: 'needs_work', issues: ['footer still cut off'] });
  const r2 = await runVisualGate({ messages: [created('hero'), updated('hero')], enabled: true, retriedAlready: true, reviewFn: m2.fn });
  check('still bad after the retry → pass anyway', r2.action === 'pass');
  check('…but with a warning line', !!r2.verdictLine && r2.verdictLine.includes('⚠') && r2.verdictLine.includes('NEEDS_WORK'));
  check('warning names the remaining issue', !!r2.verdictLine && r2.verdictLine.includes('footer still cut off'));

  // BROKEN follows the same bounded path.
  const m3 = mockReview({ verdict: 'broken', issues: ['blank page'] });
  const r3 = await runVisualGate({ messages: [created('hero')], enabled: true, retriedAlready: false, reviewFn: m3.fn });
  check('BROKEN → retry too', r3.action === 'retry' && !!r3.correction && r3.correction.includes('BROKEN'));
}

console.log('— no vision backend → unverified pass with a note —');
{
  const m = mockReview({ verdict: 'unverified', issues: [] });
  const r = await runVisualGate({ messages: [created('hero')], enabled: true, retriedAlready: false, reviewFn: m.fn });
  check('unverified passes (never blocks)', r.action === 'pass');
  check('line says unverified + points at the config', !!r.verdictLine && r.verdictLine.includes('unverified — no vision backend (set roles.vision.model)'));

  const withNote = mockReview({ verdict: 'unverified', issues: [], note: 'Playwright not installed' });
  const r2 = await runVisualGate({ messages: [created('hero')], enabled: true, retriedAlready: false, reviewFn: withNote.fn });
  check('a specific degrade note is surfaced instead', !!r2.verdictLine && r2.verdictLine.includes('Playwright not installed'));
}

console.log('— review crash → degrade, never block —');
{
  const boom = async (_id: string): Promise<VisualReviewOutcome> => { throw new Error('browser exploded'); };
  const r = await runVisualGate({ messages: [created('hero')], enabled: true, retriedAlready: false, reviewFn: boom });
  check('a throwing reviewFn still passes', r.action === 'pass');
  check('failure is reported as unverified', !!r.verdictLine && r.verdictLine.includes('unverified') && r.verdictLine.includes('browser exploded'));
}

console.log('— buildVisualCorrection —');
{
  const c = buildVisualCorrection('dash', 'NEEDS_WORK', []);
  check('no issues → still gives direction', c.includes('re-check the render'));
  check('single-retry contract is stated', c.includes('only visual retry'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
