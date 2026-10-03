/**
 * Tests for Layer 3 (visual self-correction):
 *   - src/artifacts/review.ts        — the pure critique logic
 *   - src/artifacts/review-capture.ts — the injectable preview→screenshot capture
 *   - artifact_review tool           — end-to-end orchestration (with fakes, no browser/vision)
 * Run: npx tsx test/artifact-review.test.ts
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildReviewPrompt, classifyVisionAnswer, extractIssues, buildReviewReport, formatReviewReport,
} from '../src/artifacts/review.ts';
import { captureArtifact, type CaptureDeps } from '../src/artifacts/review-capture.ts';
import { ArtifactReviewTool } from '../src/tools/artifacts/artifact-tools.ts';
import { createArtifact } from '../src/artifacts/store.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

/** A minimal ToolContext good enough to drive the artifact tools. */
function fakeCtx(cwd: string): any {
  return {
    cwd,
    sessionId: 'test',
    transaction: { write: (p: string, c: string) => fs.mkdir(path.dirname(p), { recursive: true }).then(() => fs.writeFile(p, c)) },
    permissions: {},
    askUser: async () => '',
    emit: () => {},
  };
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

// ————————————————————————————————————————————————————————————————
// Capture layer (review-capture.ts) — degrades, never throws.
// ————————————————————————————————————————————————————————————————
async function run() {
  console.log('— captureArtifact: happy path —');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-cap-'));
    let served = false, wrote = false, navigated = '';
    const deps: CaptureDeps = {
      writeFile: async (p, c) => { wrote = true; await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); },
      screenshotDir: tmp,
      serve: async () => { served = true; },
      navigateAndShoot: async ({ url, screenshotPath }) => { navigated = url; await fs.writeFile(screenshotPath, 'png'); return { consoleErrors: [], pageErrors: ['boom'] }; },
    };
    const cap = await captureArtifact({ id: 'x', type: 'html', content: '<h1>hi</h1>', versionDir: tmp }, deps);
    check('wrote the preview page', wrote);
    check('started the static server', served);
    check('navigated to the served url', navigated.includes('__preview__.html'));
    check('returned a screenshot path', !!cap.screenshotPath);
    check('surfaced page errors from the browser', cap.pageErrors.includes('boom'));
    check('no note on the happy path', cap.note === '');
  }

  console.log('— captureArtifact: Playwright missing => actionable note, no throw —');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-cap-'));
    const deps: CaptureDeps = {
      writeFile: async (p, c) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); },
      screenshotDir: tmp,
      serve: async () => {},
      navigateAndShoot: async () => { throw new Error('playwright is not installed. Run: npx playwright install chromium'); },
    };
    const cap = await captureArtifact({ id: 'x', type: 'html', content: '<h1>hi</h1>', versionDir: tmp }, deps);
    check('no screenshot when the browser is unavailable', !cap.screenshotPath);
    check('note names the exact install command', cap.note.includes('npx playwright install chromium'));
  }

  console.log('— captureArtifact: static server down => actionable note —');
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-cap-'));
    const deps: CaptureDeps = {
      writeFile: async (p, c) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); },
      screenshotDir: tmp,
      serve: async () => { throw new Error('python3 not found'); },
      navigateAndShoot: async () => { throw new Error('should not be reached'); },
    };
    const cap = await captureArtifact({ id: 'x', type: 'html', content: 'hi', versionDir: tmp }, deps);
    check('no screenshot when serving fails', !cap.screenshotPath);
    check('note explains the serve failure', /server could not start/.test(cap.note));
  }

  // ————————————————————————————————————————————————————————————————
  // artifact_review tool — end-to-end orchestration with fakes.
  // ————————————————————————————————————————————————————————————————
  async function newArtifact(html: string): Promise<{ cwd: string; id: string }> {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-art-'));
    const write = async (p: string, c: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); };
    const { manifest } = await createArtifact(cwd, { title: 'Test Page', type: 'html', content: html }, write);
    return { cwd, id: manifest.id };
  }

  console.log('— artifact_review: self-sufficient, mocked vision => structured verdict —');
  {
    const { cwd, id } = await newArtifact('<h1>hi</h1>');
    const tool = new ArtifactReviewTool();
    let capturedId = '';
    // Fake capture: pretend we rendered + screenshotted, no runtime errors.
    tool.captureFn = (async (opts) => { capturedId = opts.id; return { screenshotPath: '/tmp/fake.png', url: 'http://x', consoleErrors: [], pageErrors: [], note: '' }; }) as any;
    tool.captureDeps = (() => ({})) as any;
    // Fake vision: a clean render.
    tool.visionFn = async () => ({ content: '[via fake]\n\nLOOKS_GOOD\n- none' });
    const res = await tool.execute({ id } as any, fakeCtx(cwd));
    check('did not require a screenshot_path argument', !res.isError);
    check('captured the artifact itself', capturedId === id);
    check('verdict is looks_good', (res.metadata as any)?.verdict === 'looks_good');
    check('content shows the LOOKS_GOOD badge', res.content.includes('LOOKS_GOOD'));
  }

  console.log('— artifact_review: mocked vision NEEDS_WORK => needs_work + issues —');
  {
    const { cwd, id } = await newArtifact('<h1>hi</h1>');
    const tool = new ArtifactReviewTool();
    tool.captureFn = (async () => ({ screenshotPath: '/tmp/fake.png', url: 'http://x', consoleErrors: [], pageErrors: [], note: '' })) as any;
    tool.captureDeps = (() => ({})) as any;
    tool.visionFn = async () => ({ content: 'NEEDS_WORK\n- button is cut off\n- contrast too low' });
    const res = await tool.execute({ id } as any, fakeCtx(cwd));
    check('verdict is needs_work', (res.metadata as any)?.verdict === 'needs_work');
    check('issues carried through', ((res.metadata as any)?.issues ?? []).includes('button is cut off'));
    check('suggests artifact_update to fix', res.content.includes('artifact_update'));
  }

  console.log('— artifact_review: NO vision backend => graceful degradation, defined verdict + note —');
  {
    const { cwd, id } = await newArtifact('<h1>hi</h1>');
    const tool = new ArtifactReviewTool();
    // Capture succeeds (screenshot exists) but the vision backend is not configured.
    tool.captureFn = (async () => ({ screenshotPath: '/tmp/fake.png', url: 'http://x', consoleErrors: [], pageErrors: [], note: '' })) as any;
    tool.captureDeps = (() => ({})) as any;
    tool.visionFn = async () => ({ content: '[VISION_NOT_CONFIGURED] No vision backend available.', isError: true });
    const res = await tool.execute({ id } as any, fakeCtx(cwd));
    check('does not throw / is not an error result', !res.isError);
    check('returns a defined verdict (unverified)', (res.metadata as any)?.verdict === 'unverified');
    check('sawScreenshot is false without vision', (res.metadata as any)?.sawScreenshot === false);
    check('note points at how to configure vision', /ANTHROPIC_API_KEY|OLLAMA_VISION|OPENAI_API_KEY/.test(res.content));
  }

  console.log('— artifact_review: runtime error dominates even with no vision —');
  {
    const { cwd, id } = await newArtifact('<script>import x from "y"</script>');
    const tool = new ArtifactReviewTool();
    tool.captureFn = (async () => ({ screenshotPath: undefined, url: 'http://x', consoleErrors: [], pageErrors: ['Cannot use import statement outside a module'], note: 'Preview is live but the browser could not run.' })) as any;
    tool.captureDeps = (() => ({})) as any;
    tool.visionFn = async () => { throw new Error('should not be called without a screenshot'); };
    const res = await tool.execute({ id } as any, fakeCtx(cwd));
    check('page error forces broken', (res.metadata as any)?.verdict === 'broken');
    check('surfaces the runtime error', res.content.includes('import statement'));
    check('carries the capture note forward', res.content.includes('could not run'));
  }

  console.log('— artifact_review: missing artifact => clear actionable error —');
  {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-art-'));
    const tool = new ArtifactReviewTool();
    const res = await tool.execute({ id: 'does-not-exist' } as any, fakeCtx(cwd));
    check('errors on unknown artifact', res.isError === true);
    check('error names the artifact', res.content.includes('does-not-exist'));
  }

  console.log('— artifact_review: caller-supplied screenshot_path bypasses capture —');
  {
    const { cwd, id } = await newArtifact('<h1>hi</h1>');
    const shot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-shot-')), 'shot.png');
    await fs.writeFile(shot, 'png');
    const tool = new ArtifactReviewTool();
    let captureCalled = false;
    tool.captureFn = (async () => { captureCalled = true; return { consoleErrors: [], pageErrors: [], note: '' }; }) as any;
    tool.visionFn = async () => ({ content: 'LOOKS_GOOD' });
    const res = await tool.execute({ id, screenshot_path: shot } as any, fakeCtx(cwd));
    check('capture is skipped when a screenshot is provided', !captureCalled);
    check('still produces a verdict', (res.metadata as any)?.verdict === 'looks_good');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
