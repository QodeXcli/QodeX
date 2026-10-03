/**
 * Lean mode (browser.lean): a browser nobody is looking at skips images, fonts and
 * audio/video. The DOM, scripts, styles, XHR/fetch, forms and cookies are untouched, so
 * the agent's snapshots, clicks and sign-ups behave the same — only the pixels go.
 *
 * How: one CDP session per tab enables the Fetch domain for the Image / Font / Media
 * resource types only and fails those requests with BlockedByClient. Nothing else ever
 * pauses, and — unlike Playwright's context.route(), which turns the HTTP cache off for
 * every request — the cache keeps working (measured: a cacheable script is fetched once
 * over three page loads with this, three times with a route).
 *
 * Never on your own Chrome (cdpUrl), never on loopback / LAN / file: pages (a dev
 * server's images are what you are building), and it switches itself off for the rest
 * of the session the moment pixels matter: a takeover, the live view, a screenshot, a
 * bot check (the human solving it must see it). Cross-site iframes (a CAPTCHA widget)
 * are separate targets and are never touched.
 *
 * Not a way to look less automated: it does not change what a site sees about the
 * browser, and a page that waits for its images can see that they failed.
 */

import type { Page } from 'playwright';
import { logger } from '../../utils/logger.js';
import type { BrowserConfig } from '../../config/agent-config.js';

/** CDP resource types lean mode skips. */
export const LEAN_RESOURCE_TYPES = ['Image', 'Font', 'Media'] as const;

/** Chromium's error text for a request a DevTools client failed with BlockedByClient. */
export const LEAN_BLOCK_ERROR = 'net::ERR_BLOCKED_BY_CLIENT.Inspector';

/** Whether a launch with this config starts lean. PURE. */
export function leanEnabled(cfg: Pick<BrowserConfig, 'lean' | 'headless'>, mode: 'launch' | 'cdp' | 'none'): boolean {
  if (mode !== 'launch') return false;
  if (cfg.lean === 'on') return true;
  if (cfg.lean === 'off') return false;
  return cfg.headless;
}

/** The request log's failure text for a request lean mode skipped. */
export const LEAN_FAILURE_TEXT = 'not loaded (lean mode: images, fonts and media are skipped)';

interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, handler: (ev: any) => void): unknown;
  detach?(): Promise<void>;
}

interface ContextLike {
  newCDPSession(page: Page): Promise<CdpLike>;
}

export interface LeanStatus {
  /** Lean mode is skipping resources right now. */
  on: boolean;
  /** Requests skipped this session. */
  blocked: number;
  /** Why it was switched off (e.g. "screenshot"), if it was on and no longer is. */
  suspended?: string;
}

export class LeanBlocker {
  private readonly sessions = new Map<Page, CdpLike>();
  private readonly pending = new Set<Promise<void>>();
  private readonly pageBlocked = new WeakMap<Page, number>();
  private suspendedBy: string | undefined;
  private blockedTotal = 0;

  /**
   * @param enabled  lean mode for this launch (leanEnabled()).
   * @param exempt   pages whose resources are never skipped (by the page's URL).
   */
  constructor(readonly enabled: boolean, private readonly exempt: (pageUrl: string) => boolean) {}

  /** Lean mode is skipping resources right now. */
  get active(): boolean {
    return this.enabled && this.suspendedBy === undefined;
  }

  status(): LeanStatus {
    return { on: this.active, blocked: this.blockedTotal, ...(this.enabled && this.suspendedBy ? { suspended: this.suspendedBy } : {}) };
  }

  /** Requests skipped on this tab since its last main-frame navigation. */
  blockedOn(page: Page): number {
    return this.pageBlocked.get(page) ?? 0;
  }

  /** A main-frame navigation: the tab's count starts over. */
  navigated(page: Page): void {
    if (this.pageBlocked.has(page)) this.pageBlocked.set(page, 0);
  }

  /** Start skipping on a tab. Never throws; the returned promise settles once it is in force. */
  attach(ctx: ContextLike, page: Page): Promise<void> {
    if (!this.active || this.sessions.has(page)) return Promise.resolve();
    const run = (async () => {
      let session: CdpLike;
      try {
        session = await ctx.newCDPSession(page);
      } catch (e) {
        logger.debug('lean: no CDP session for tab', { err: String((e as any)?.message ?? e).split('\n')[0] });
        return;
      }
      if (!this.active) { await session.detach?.().catch(() => {}); return; }
      this.sessions.set(page, session);
      session.on('Fetch.requestPaused', (ev: any) => {
        const requestId = String(ev?.requestId ?? '');
        if (!requestId) return;
        let pageUrl = '';
        try { pageUrl = page.url(); } catch { pageUrl = ''; }
        if (!this.active || this.exempt(pageUrl)) {
          session.send('Fetch.continueRequest', { requestId }).catch(() => {});
          return;
        }
        this.blockedTotal++;
        this.pageBlocked.set(page, (this.pageBlocked.get(page) ?? 0) + 1);
        session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      });
      try {
        await session.send('Fetch.enable', { patterns: LEAN_RESOURCE_TYPES.map(resourceType => ({ resourceType, requestStage: 'Request' })) });
      } catch (e) {
        this.sessions.delete(page);
        logger.debug('lean: Fetch.enable failed', { err: String((e as any)?.message ?? e).split('\n')[0] });
        return;
      }
      if (!this.active) await this.release(page, session);
    })().finally(() => { this.pending.delete(run); });
    this.pending.add(run);
    return run;
  }

  /** Every attach() started so far is in force (or gave up). */
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /**
   * Stop skipping for the rest of this session: pixels matter now. Idempotent — the
   * first reason sticks. Pages already loaded keep their missing images until reloaded.
   */
  async suspend(reason: string): Promise<boolean> {
    if (!this.active) return false;
    this.suspendedBy = reason;
    logger.info('Lean browser mode off for this session', { reason });
    await Promise.all([...this.sessions].map(([page, session]) => this.release(page, session)));
    return true;
  }

  /** The tab closed. */
  forget(page: Page): void {
    this.sessions.delete(page);
  }

  private async release(page: Page, session: CdpLike): Promise<void> {
    this.sessions.delete(page);
    await session.send('Fetch.disable').catch(() => {});
    await session.detach?.().catch(() => {});
  }
}
