/**
 * Layer-3 auto-capture: turn an artifact into a screenshot the vision model can judge,
 * WITHOUT the caller having to hand-orchestrate artifact_preview → browser_navigate →
 * browser_screenshot → browser_console first.
 *
 * `artifact_review` used to REQUIRE a `screenshot_path` argument, which made Layer 3 a
 * fragile four-step manual dance: the model had to preview, launch the browser, screenshot,
 * read the console, and thread every result back in — in the right order. Miss a step and
 * the tool rejected the call at schema validation, never reaching the graceful-degradation
 * path. This module lets the review tool do all of that itself.
 *
 * It is deliberately a thin, INJECTABLE seam: the review tool calls `captureArtifact(...)`,
 * but tests pass their own capturer so the pure logic stays browser-free. Every failure mode
 * (no Playwright, no python3 to serve, navigation timeout) resolves to a structured result
 * with an actionable `note` — it never throws.
 */
import * as path from 'path';
import { buildPreviewHtml, PREVIEW_FILE, previewServerName, previewPort } from './preview.js';
import type { ArtifactType } from './store.js';

export interface CaptureResult {
  /** Absolute path to the captured PNG, or undefined if a screenshot couldn't be taken. */
  screenshotPath?: string;
  /** The URL that was served / navigated to (for the report + reuse). */
  url?: string;
  /** Console error strings collected from the page during load. */
  consoleErrors: string[];
  /** Uncaught page error strings collected during load. */
  pageErrors: string[];
  /** A human-readable, actionable note when capture couldn't fully complete (e.g. Playwright
   *  missing). Empty string on full success. */
  note: string;
}

export interface CaptureDeps {
  /** Serve `dir` statically so `url` resolves. Throws with an actionable message on failure. */
  serve: (opts: { name: string; port: number; dir: string }) => Promise<void>;
  /** Navigate the browser to `url` and screenshot it to `screenshotPath`. Returns the
   *  console/page errors the page reported. Throws (e.g. Playwright not installed) → the
   *  caller degrades. */
  navigateAndShoot: (opts: { url: string; screenshotPath: string }) => Promise<{ consoleErrors: string[]; pageErrors: string[] }>;
  /** Write the preview HTML to disk (usually ctx.transaction.write). */
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** Where to drop the screenshot PNG. */
  screenshotDir: string;
}

/**
 * Build+serve the artifact preview, open it in the browser, and screenshot it. Any failure
 * (can't serve, Playwright not installed, navigation error) is caught and reported via `note`
 * with the exact next step — the returned result is always usable by buildReviewReport.
 */
export async function captureArtifact(
  opts: { id: string; type: ArtifactType; content: string; versionDir: string },
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const empty: CaptureResult = { consoleErrors: [], pageErrors: [], note: '' };

  // 1. Build + write the self-contained preview page next to the version file.
  const html = buildPreviewHtml(opts.type, opts.content);
  const previewPath = path.join(opts.versionDir, PREVIEW_FILE);
  try {
    await deps.writeFile(previewPath, html);
  } catch (e: any) {
    return { ...empty, note: `Could not write the preview page (${e?.message ?? e}).` };
  }

  // 2. Serve the version dir statically.
  const port = previewPort(opts.id);
  const name = previewServerName(opts.id);
  const url = `http://localhost:${port}/${PREVIEW_FILE}`;
  try {
    await deps.serve({ name, port, dir: opts.versionDir });
  } catch (e: any) {
    return {
      ...empty,
      url,
      note:
        `Preview page written to ${previewPath}, but the static server could not start ` +
        `(${e?.message ?? e}). Ensure python3 is installed, or run artifact_preview / artifact_live ` +
        `manually, then browser_navigate + browser_screenshot and pass screenshot_path.`,
    };
  }

  // 3. Navigate + screenshot. Playwright is optional — a missing browser degrades cleanly.
  const screenshotPath = path.join(deps.screenshotDir, `artifact-review-${opts.id}-${Date.now()}.png`);
  try {
    const { consoleErrors, pageErrors } = await deps.navigateAndShoot({ url, screenshotPath });
    return { screenshotPath, url, consoleErrors, pageErrors, note: '' };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const playwrightMissing = /playwright is not installed|Executable doesn.?t exist|npx playwright install/i.test(msg);
    const note = playwrightMissing
      ? `Preview is live at ${url}, but the browser could not run to screenshot it. ` +
        `Install it once: npx playwright install chromium (and: npm install playwright). ` +
        `Until then the visual review can't see the render — only runtime errors are checked.`
      : `Preview is live at ${url}, but the screenshot failed (${msg}). ` +
        `You can browser_navigate to it and browser_screenshot manually, then pass screenshot_path.`;
    return { ...empty, url, note };
  }
}
