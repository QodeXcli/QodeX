/**
 * Artifact Review — Layer 3 of the Living Artifact system: the closed visual feedback loop.
 *
 * Layers 1 (versioned store) and 2 (browser preview) let an artifact be created and rendered.
 * Layer 3 lets the model SEE what rendered and judge it: it screenshots the live preview,
 * asks a vision model to critique the rendered output against the artifact's intent, folds
 * in any runtime/console errors the browser reported, and returns a structured verdict the
 * parent model can act on — typically by calling `artifact_update` and reviewing again.
 *
 * This is the part no blind-iframe artifact tool can do: the model isn't guessing whether its
 * UI looks right, it's looking at a real Chromium render and correcting from evidence.
 *
 * This module is the PURE core — it builds the vision prompt and assembles the verdict from
 * inputs (vision answer text, console errors, page errors). The orchestration tool wires it to
 * the real browser + vision tools and degrades gracefully when either is unavailable, so the
 * pure logic here is fully unit-testable without a browser or a model.
 */
import type { ArtifactType } from './store.js';

export interface ReviewInputs {
  /** Free-text answer from the vision model about the rendered screenshot (empty if vision unavailable). */
  visionAnswer?: string;
  /** Console error strings collected from the page (empty if none / browser unavailable). */
  consoleErrors?: string[];
  /** Uncaught page errors collected from the page (empty if none). */
  pageErrors?: string[];
  /** Whether a screenshot was actually captured and analyzed. */
  sawScreenshot: boolean;
}

export type ReviewVerdict = 'looks_good' | 'needs_work' | 'broken' | 'unverified';

export interface ReviewReport {
  verdict: ReviewVerdict;
  /** One-line human summary. */
  summary: string;
  /** Concrete issues found, most severe first. */
  issues: string[];
  /** The raw vision answer, passed through for the model to read. */
  visionAnswer: string;
}

/**
 * Build the prompt sent to the vision model. We ask for a focused critique, not a description,
 * and request a leading verdict token so the report can be classified deterministically.
 */
export function buildReviewPrompt(opts: { type: ArtifactType; title: string; intent?: string }): string {
  const intentLine = opts.intent && opts.intent.trim()
    ? `The artifact is meant to be: ${opts.intent.trim()}\n`
    : '';
  return (
    `You are reviewing a rendered ${opts.type} artifact titled "${opts.title}".\n` +
    intentLine +
    `Look at the screenshot and judge whether it rendered correctly and looks right.\n` +
    `Start your answer with exactly one of these tokens on its own line: ` +
    `LOOKS_GOOD, NEEDS_WORK, or BROKEN.\n` +
    `- BROKEN: blank/empty page, an error message is shown, or core content is missing.\n` +
    `- NEEDS_WORK: it renders but has clear visual problems (overlap, cut-off, unreadable contrast, misalignment).\n` +
    `- LOOKS_GOOD: it renders correctly with no obvious visual issues.\n` +
    `Then, on the following lines, list any specific problems as short bullet points (or "none").`
  );
}

/** Classify the vision model's free-text answer into a verdict using its leading token. */
export function classifyVisionAnswer(answer: string): ReviewVerdict {
  const head = (answer || '').trim().toUpperCase();
  if (/^BROKEN\b/.test(head)) return 'broken';
  if (/^NEEDS_WORK\b/.test(head)) return 'needs_work';
  if (/^LOOKS_GOOD\b/.test(head)) return 'looks_good';
  // No explicit token — infer conservatively from wording.
  if (/\b(blank|empty|error|nothing renders|failed to render|white screen)\b/i.test(answer)) return 'broken';
  if (/\b(overlap|cut off|cut-off|unreadable|misalign|too small|off-screen|broken layout)\b/i.test(answer)) return 'needs_work';
  if (/\b(looks good|renders correctly|no issues|correct)\b/i.test(answer)) return 'looks_good';
  return 'unverified';
}

/** Pull bulleted/■ issue lines out of the vision answer (everything after the verdict token). */
export function extractIssues(answer: string): string[] {
  const lines = (answer || '').split('\n').map(l => l.trim());
  const out: string[] = [];
  for (const l of lines) {
    const m = l.match(/^[-*•]\s+(.*)$/);
    if (m && m[1] && !/^none\.?$/i.test(m[1].trim())) out.push(m[1].trim());
  }
  return out;
}

/**
 * Assemble the final report. Runtime/page errors are authoritative: if the page threw, the
 * artifact is BROKEN regardless of what the screenshot looked like (a blank page can look
 * "fine" to a weak vision model). Otherwise the vision verdict stands.
 */
export function buildReviewReport(inputs: ReviewInputs): ReviewReport {
  const consoleErrors = inputs.consoleErrors ?? [];
  const pageErrors = inputs.pageErrors ?? [];
  const runtimeErrors = [...pageErrors, ...consoleErrors];

  // If we couldn't see anything, we can't claim a visual verdict.
  if (!inputs.sawScreenshot && runtimeErrors.length === 0) {
    return {
      verdict: 'unverified',
      summary: 'Could not capture a screenshot or any runtime errors — preview not verified visually.',
      issues: [],
      visionAnswer: inputs.visionAnswer ?? '',
    };
  }

  const visionVerdict = classifyVisionAnswer(inputs.visionAnswer ?? '');
  const visionIssues = extractIssues(inputs.visionAnswer ?? '');

  // Runtime errors dominate.
  if (runtimeErrors.length > 0) {
    return {
      verdict: 'broken',
      summary: `The page reported ${runtimeErrors.length} runtime error(s) — the artifact is not rendering correctly.`,
      issues: [
        ...pageErrors.map(e => `Page error: ${e}`),
        ...consoleErrors.map(e => `Console error: ${e}`),
        ...visionIssues,
      ],
      visionAnswer: inputs.visionAnswer ?? '',
    };
  }

  // No runtime errors → trust the vision verdict.
  const summaryByVerdict: Record<ReviewVerdict, string> = {
    looks_good: 'Rendered correctly with no obvious visual issues.',
    needs_work: 'Renders, but the review found visual problems to fix.',
    broken: 'The review judged the render broken (blank or missing core content).',
    unverified: 'Screenshot captured but the review was inconclusive.',
  };

  return {
    verdict: visionVerdict,
    summary: summaryByVerdict[visionVerdict],
    issues: visionIssues,
    visionAnswer: inputs.visionAnswer ?? '',
  };
}

/** Render the report as the text the parent model reads back. */
export function formatReviewReport(artifactId: string, version: number, report: ReviewReport): string {
  const lines: string[] = [];
  const badge: Record<ReviewVerdict, string> = {
    looks_good: '✓ LOOKS_GOOD',
    needs_work: '✎ NEEDS_WORK',
    broken: '✗ BROKEN',
    unverified: '? UNVERIFIED',
  };
  lines.push(`Review of "${artifactId}" v${version}: ${badge[report.verdict]}`);
  lines.push(report.summary);
  if (report.issues.length) {
    lines.push('Issues:');
    for (const i of report.issues) lines.push(`  - ${i}`);
  }
  if (report.verdict === 'needs_work' || report.verdict === 'broken') {
    lines.push(`Fix with artifact_update id="${artifactId}" (new version), then artifact_review again.`);
  }
  return lines.join('\n');
}
