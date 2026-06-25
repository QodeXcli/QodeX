/**
 * Browser session manager.
 *
 * Owns a single Playwright Browser + Page across all browser_* tool calls in a
 * QodeX session. The lifecycle is intentionally simple:
 *
 *   - First browser_* call lazily imports playwright + launches Chromium.
 *   - All subsequent calls reuse the same Page.
 *   - `closeBrowser()` is called on session end (or `/browser close`).
 *
 * Why a singleton: launching Chromium is ~1-3 seconds. Re-launching on every
 * tool call would be unusable. Within one session, the user's intent is
 * usually "drive a flow" (navigate, click, screenshot, evaluate) so reusing
 * one page mirrors what they'd do manually in a browser tab.
 *
 * Playwright is an OPTIONAL dependency. If the user hasn't run
 * `npx playwright install chromium`, the import throws at runtime. We catch
 * that and return a clear "playwright not installed" tool result so the agent
 * can tell the user instead of crashing.
 *
 * Concurrency note: tools that touch the page are serialized at the session
 * level — multiple parallel browser_click calls would race the page. We assume
 * the agent issues them sequentially (which the loop does for read-write tools).
 *
 * No headed-mode option here intentionally — agentic coding is unattended.
 * Users who want to SEE the browser can set QODEX_BROWSER_HEADED=1.
 */

import { logger } from '../../utils/logger.js';

// We can't `import` playwright statically because it's optional. Instead we
// keep typed handles loose and dynamic-import on first use.
type Browser = any;
type BrowserContext = any;
type Page = any;
type ConsoleMessage = any;

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** True when we ATTACHED to an already-running browser over CDP (vs launched our
   *  own). When attached we must never kill the user's browser on cleanup. */
  attached: boolean;
  /** Console messages captured since session start (cleared on navigate). */
  consoleBuffer: Array<{ type: string; text: string; location?: string }>;
  /** Network requests captured (URL + status). Cleared on navigate. */
  requestBuffer: Array<{ url: string; method: string; status?: number; ok?: boolean }>;
  /** Page errors caught via the 'pageerror' event. Cleared on navigate. */
  errorBuffer: Array<{ message: string; stack?: string }>;
}

let session: BrowserSession | null = null;
let initInFlight: Promise<BrowserSession> | null = null;

/** CDP endpoint to ATTACH to instead of launching a fresh Chromium. Set from config
 *  (`browser.cdpUrl`) by bootstrap; `QODEX_BROWSER_CDP_URL` env overrides it. */
let configuredCdpUrl: string | undefined;
export function setBrowserCdpUrl(url: string | undefined): void {
  configuredCdpUrl = (url ?? '').trim() || undefined;
}
/**
 * Where to attach, if anywhere. Accepts a full CDP/DevTools URL
 * (http://127.0.0.1:9222) — drive your OWN logged-in Chrome / Brave / Arc / Edge (or any
 * Chromium browser, e.g. an upcoming AI browser) started with `--remote-debugging-port`,
 * with your real cookies + sessions. Empty → launch a fresh headless Chromium (default).
 */
export function resolveBrowserCdpUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (env.QODEX_BROWSER_CDP_URL ?? '').trim() || configuredCdpUrl;
}

/**
 * Lazily import playwright. Throws a clear error if not installed.
 */
async function importPlaywright(): Promise<typeof import('playwright')> {
  try {
    // @ts-ignore — optional dep, may not be installed
    return await import('playwright');
  } catch (e: any) {
    throw new Error(
      'playwright is not installed. Run:\n' +
      '  npm install playwright\n' +
      '  npx playwright install chromium\n' +
      '(playwright is an optional dependency to keep base install small)',
    );
  }
}

/**
 * Get the active session, launching the browser if needed.
 * Calls are coalesced — concurrent first-time calls share one launch.
 */
export async function getSession(): Promise<BrowserSession> {
  if (session) return session;
  if (initInFlight) return initInFlight;

  initInFlight = (async () => {
    const playwright = await importPlaywright();
    const cdpUrl = resolveBrowserCdpUrl();

    let browser: Browser, context: BrowserContext, page: Page, attached = false;
    if (cdpUrl) {
      // ATTACH to an already-running browser (the user's own, with real logins). Reuse
      // its existing default context + an open tab so cookies/sessions are intact; only
      // open a fresh tab if none exist. We never create our own isolated context here —
      // that would defeat the point (a blank, logged-OUT session).
      browser = await playwright.chromium.connectOverCDP(cdpUrl);
      context = browser.contexts()[0] ?? (await browser.newContext());
      const open = (context.pages() as Page[]).find((p: Page) => !p.isClosed?.());
      page = open ?? (await context.newPage());
      attached = true;
      logger.info('Browser session ATTACHED over CDP', { cdpUrl });
    } else {
      const headed = process.env.QODEX_BROWSER_HEADED === '1';
      browser = await playwright.chromium.launch({
        headless: !headed,
        // --disable-blink-features prevents the "Chrome is being controlled by
        // automated test software" infobar from interfering with element positions.
        args: ['--disable-blink-features=AutomationControlled'],
      });
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 QodeX/0.7',
      });
      page = await context.newPage();
      logger.info('Browser session launched', { headed });
    }

    const s: BrowserSession = { browser, context, page, attached, consoleBuffer: [], requestBuffer: [], errorBuffer: [] };
    wireSessionListeners(s, page);
    session = s;
    return s;
  })();

  try {
    return await initInFlight;
  } finally {
    initInFlight = null;
  }
}

/** Install the console/pageerror/network listeners that fill the read buffers. Tools
 *  read from these rather than installing per-call listeners (avoids missing events). */
function wireSessionListeners(s: BrowserSession, page: Page): void {
  page.on('console', (msg: ConsoleMessage) => {
    s.consoleBuffer.push({ type: msg.type(), text: msg.text(), location: msg.location()?.url });
    if (s.consoleBuffer.length > 500) s.consoleBuffer.splice(0, 100);
  });
  page.on('pageerror', (err: Error) => {
    s.errorBuffer.push({ message: err.message, stack: err.stack });
    if (s.errorBuffer.length > 100) s.errorBuffer.splice(0, 20);
  });
  page.on('requestfinished', async (req: any) => {
    const resp = await req.response();
    s.requestBuffer.push({ url: req.url(), method: req.method(), status: resp?.status(), ok: resp?.ok() });
    if (s.requestBuffer.length > 500) s.requestBuffer.splice(0, 100);
  });
  page.on('requestfailed', (req: any) => {
    s.requestBuffer.push({ url: req.url(), method: req.method(), ok: false });
  });
}

/** Clear the per-page buffers. Called automatically on browser_navigate. */
export function clearBuffers(s: BrowserSession): void {
  s.consoleBuffer.length = 0;
  s.requestBuffer.length = 0;
  s.errorBuffer.length = 0;
}

/** Close the browser. Idempotent. When ATTACHED to the user's own browser we drop the
 *  connection WITHOUT closing it — killing someone's logged-in Chrome would be hostile. */
export async function closeBrowser(): Promise<void> {
  if (!session) return;
  if (session.attached) {
    logger.debug('Browser was attached over CDP — disconnecting, not closing');
    session = null; // let the CDP socket GC; the user's browser keeps running
    return;
  }
  try {
    await session.browser.close();
  } catch (e: any) {
    logger.debug('Browser close failed', { err: e?.message });
  }
  session = null;
}

/** Whether playwright is available on this machine. Used by `/network` etc. */
export async function isPlaywrightAvailable(): Promise<boolean> {
  try {
    await importPlaywright();
    return true;
  } catch {
    return false;
  }
}

// Register process exit hook so we don't leak a chromium process if the user
// Ctrl+C's QodeX without cleanup. Best-effort: if it doesn't fire (SIGKILL etc),
// Playwright's own subprocess management catches it.
process.on('exit', () => {
  if (session && !session.attached) {
    try { session.browser.close(); } catch { /* ignore */ }
  }
});
process.on('SIGINT', () => {
  if (session && !session.attached) {
    try { session.browser.close(); } catch { /* ignore */ }
  }
});
