/**
 * Tests for src/artifacts/review.ts — the pure Layer 3 critique logic.
 * Run: node --experimental-strip-types test/artifact-review.test.ts
 */
import {
  buildReviewPrompt, classifyVisionAnswer, extractIssues, buildReviewReport, formatReviewReport,
} from '../src/artifacts/review.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— buildReviewPrompt —');
{
  const p = buildReviewPrompt({ type: 'react', title: 'Counter', intent: 'a button that increments a number' });
  check('mentions the type', p.includes('react'));
  check('mentions the title', p.includes('Counter'));
  check('includes the intent', p.includes('increments a number'));
  check('asks for a verdict token', p.includes('LOOKS_GOOD') && p.includes('NEEDS_WORK') && p.includes('BROKEN'));
  const p2 = buildReviewPrompt({ type: 'html', title: 'X' });
  check('works without intent', !p2.includes('meant to be'));
}

console.log('— classifyVisionAnswer —');
{
  check('reads LOOKS_GOOD token', classifyVisionAnswer('LOOKS_GOOD\nall good') === 'looks_good');
  check('reads NEEDS_WORK token', classifyVisionAnswer('NEEDS_WORK\n- button cut off') === 'needs_work');
  check('reads BROKEN token', classifyVisionAnswer('BROKEN\nblank page') === 'broken');
  check('token is case-insensitive', classifyVisionAnswer('looks_good') === 'looks_good');
  check('infers broken from "blank"', classifyVisionAnswer('The page is completely blank') === 'broken');
  check('infers needs_work from "overlap"', classifyVisionAnswer('The text and button overlap') === 'needs_work');
  check('infers good from "renders correctly"', classifyVisionAnswer('It renders correctly') === 'looks_good');
  check('unverified when ambiguous', classifyVisionAnswer('hmm, interesting') === 'unverified');
}

console.log('— extractIssues —');
{
  const a = 'NEEDS_WORK\n- button is cut off\n- contrast too low\n* extra dash style';
  const issues = extractIssues(a);
  check('extracts dash bullets', issues.includes('button is cut off'));
  check('extracts multiple', issues.length === 3);
  check('ignores "none"', extractIssues('LOOKS_GOOD\n- none').length === 0);
}

console.log('— buildReviewReport: runtime errors dominate —');
{
  const r = buildReviewReport({ visionAnswer: 'LOOKS_GOOD\nlooks fine', pageErrors: ['Cannot use import statement outside a module'], sawScreenshot: true });
  check('page error forces broken even if vision said good', r.verdict === 'broken');
  check('includes the page error as an issue', r.issues.some(i => i.includes('import statement')));
}
{
  const r = buildReviewReport({ visionAnswer: 'LOOKS_GOOD', consoleErrors: ['TypeError: x is undefined'], sawScreenshot: true });
  check('console error forces broken', r.verdict === 'broken');
}

console.log('— buildReviewReport: trust vision when no runtime errors —');
{
  const good = buildReviewReport({ visionAnswer: 'LOOKS_GOOD\n- none', sawScreenshot: true });
  check('clean + good vision => looks_good', good.verdict === 'looks_good');
  const work = buildReviewReport({ visionAnswer: 'NEEDS_WORK\n- button off-center', sawScreenshot: true });
  check('clean + needs_work vision => needs_work', work.verdict === 'needs_work');
  check('needs_work carries issues', work.issues.includes('button off-center'));
}

console.log('— buildReviewReport: unverified —');
{
  const u = buildReviewReport({ sawScreenshot: false });
  check('no screenshot + no errors => unverified', u.verdict === 'unverified');
  // but runtime errors without a screenshot are still authoritative
  const b = buildReviewReport({ sawScreenshot: false, pageErrors: ['boom'] });
  check('errors without screenshot still => broken', b.verdict === 'broken');
}

console.log('— formatReviewReport —');
{
  const r = buildReviewReport({ visionAnswer: 'NEEDS_WORK\n- fix spacing', sawScreenshot: true });
  const txt = formatReviewReport('counter', 2, r);
  check('shows verdict badge', txt.includes('NEEDS_WORK'));
  check('shows the issue', txt.includes('fix spacing'));
  check('suggests artifact_update for needs_work', txt.includes('artifact_update'));
  const good = formatReviewReport('counter', 1, buildReviewReport({ visionAnswer: 'LOOKS_GOOD', sawScreenshot: true }));
  check('no update suggestion when good', !good.includes('artifact_update'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
