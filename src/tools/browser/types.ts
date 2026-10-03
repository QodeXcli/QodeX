/**
 * Contract for the dedicated QodeX Browser.
 *
 * The browser manager owns one persistent Chromium (or a CDP-attached Chrome)
 * with multiple tabs. Tools, the control center (live view + human takeover),
 * Sentinel (element introspection), the workflow recorder and channels all talk
 * to it through this interface, so each can be built and tested independently.
 *
 * Access it with `await getBrowserManager()`; the implementation in session.ts
 * registers itself as the factory when imported. Playwright objects are typed
 * `any` because playwright is an optional dependency.
 */

export interface TabInfo {
  /** 0-based position in the tab strip. */
  index: number;
  /** Stable id for the life of the tab. */
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserStatus {
  running: boolean;
  /** 'launch' = QodeX-owned Chromium, 'cdp' = attached to the user's Chrome. */
  mode: 'launch' | 'cdp' | 'none';
  headless: boolean;
  profile: string;
  executable?: string;
  version?: string;
  tabs: TabInfo[];
  /** A human has taken over control in the control center; agent actions wait. */
  takeover: boolean;
  takeoverBy?: string;
  downloadsDir: string;
}

export interface ScreencastFrame {
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
  ts: number;
}

/** What Sentinel / the recorder need to know about a target element. */
export interface ElementInfo {
  ref?: string;
  role?: string;
  name?: string;
  tag?: string;
  /** <input type> */
  inputType?: string;
  autocomplete?: string;
  isPassword?: boolean;
  href?: string;
  text?: string;
  /** Action URL of the enclosing <form>, if any. */
  formAction?: string;
  /** Stable selector usable for replay (role+name, #id, data-testid, css). */
  selector?: string;
}

/** One agent- or human-performed browser action (fed to the workflow recorder). */
export interface BrowserActionRecord {
  tool: string;
  args: Record<string, unknown>;
  url: string;
  title?: string;
  element?: ElementInfo;
  /** 'agent' for tool calls, 'human' for control-center takeover / demonstration. */
  actor: 'agent' | 'human';
  ts: number;
}

export type HumanInputEvent =
  /** Coordinates are in screencast-frame pixels; frameWidth/Height let the manager rescale to the viewport. */
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clickCount?: number; frameWidth?: number; frameHeight?: number }
  | { type: 'move'; x: number; y: number; frameWidth?: number; frameHeight?: number }
  /**
   * The human's own press-and-hold / drag, relayed from a phone or mouse in the live
   * view ('down' → 'move'… → 'up'). Never synthesized: each event is one the person
   * made. The manager releases a button held longer than HUMAN_HOLD_MAX_MS by itself.
   */
  | { type: 'down'; x: number; y: number; button?: 'left' | 'right' | 'middle'; frameWidth?: number; frameHeight?: number }
  | { type: 'up'; x?: number; y?: number; button?: 'left' | 'right' | 'middle'; frameWidth?: number; frameHeight?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'scroll'; dx: number; dy: number; x?: number; y?: number; frameWidth?: number; frameHeight?: number }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' };

/** A rectangle of the viewport in CSS pixels. */
export interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A human press-and-hold is released by the manager after this long (a lost 'up'). */
export const HUMAN_HOLD_MAX_MS = 20_000;

export interface LaunchOverrides {
  headless?: boolean;
  profile?: string;
  cdpUrl?: string;
}

export interface BrowserManager {
  /** Launch (or attach) if not running. Coalesces concurrent callers. */
  ensure(overrides?: LaunchOverrides): Promise<void>;
  isRunning(): boolean;
  status(): BrowserStatus;
  /** Playwright Page of the active tab (launches if needed). */
  activePage(): Promise<any>;
  /** Playwright BrowserContext or null when not running. */
  context(): any | null;
  tabs(): TabInfo[];
  newTab(url?: string): Promise<TabInfo>;
  switchTab(index: number): Promise<TabInfo>;
  closeTab(index?: number): Promise<void>;
  /** Close everything (persistent profile data stays on disk). Idempotent. */
  close(): Promise<void>;
  /** Close and relaunch with different settings (e.g. headed for a demo/login). */
  restart(overrides?: LaunchOverrides): Promise<void>;

  /** Live view: stream JPEG frames of the active tab. Returns a stop function. */
  startScreencast(onFrame: (f: ScreencastFrame) => void, opts?: { quality?: number; maxFps?: number }): Promise<() => Promise<void>>;
  /**
   * One JPEG of the active tab's viewport — or of `opts.clip` only (viewport CSS
   * pixels, clamped to the viewport), e.g. the challenge box a hand-off card shows.
   */
  screenshotJpeg(quality?: number, opts?: { clip?: ScreenshotClip }): Promise<Buffer>;

  /** Human takeover: while on, agent browser actions wait (or fail with [HUMAN_TAKEOVER]). */
  setTakeover(on: boolean, by?: string): void;
  isTakeover(): boolean;
  /** Resolve when takeover ends (or immediately if not active). */
  waitForTakeoverEnd(signal?: AbortSignal): Promise<void>;
  /** Apply a human input event from the control center to the active tab. */
  dispatchInput(ev: HumanInputEvent): Promise<void>;
  /** Release a mouse button the human still holds (lost 'up', takeover ended). Optional. */
  releaseHumanMouse?(): Promise<void>;

  /**
   * Resolve a target on the active tab to a Playwright Locator. `ref` is a ref
   * from the latest browser_snapshot ("e12", "f1e3"); `selector` is any
   * Playwright selector. Throws a clear Error ("[STALE_REF] ...") when the ref is
   * unknown so callers can tell the model to re-snapshot.
   */
  locator(target: { ref?: string; selector?: string }): Promise<any>;
  /** URL of the active tab ('' when not running). */
  activeUrl(): string;

  /** Describe the element behind a snapshot ref (e.g. "e12") on the active tab. */
  describeRef(ref: string): Promise<ElementInfo | null>;
  /**
   * Describe the element behind a Playwright selector on the active tab: the FIRST
   * match, `page.locator(selector).first()` (a snapshot ref in the selector field is
   * described as that ref). A caller that acts on a different match must pass an
   * nth-qualified selector (`… >> nth=2`, zero-based), or it describes the wrong element.
   */
  describeSelector(selector: string): Promise<ElementInfo | null>;

  /** Subscribe to performed actions (agent + human). Returns unsubscribe. */
  onAction(listener: (rec: BrowserActionRecord) => void): () => void;
  /** Publish an action record (tools call this after a successful action). */
  recordAction(rec: Omit<BrowserActionRecord, 'ts'> & { ts?: number }): void;
}

// ── accessor ────────────────────────────────────────────────────────────────

let factory: (() => BrowserManager) | null = null;
let instance: BrowserManager | null = null;

/** Called by the implementation module (session.ts) at import time. */
export function registerBrowserManagerFactory(f: () => BrowserManager): void {
  factory = f;
}

/** The process-wide browser manager (does NOT launch the browser by itself). */
export async function getBrowserManager(): Promise<BrowserManager> {
  if (instance) return instance;
  if (!factory) await import('./session.js');
  // Another caller may have created it while we awaited the import: never create a
  // second manager (the first one's browser would be orphaned, holding the profile).
  if (instance) return instance;
  if (!factory) throw new Error('QodeX browser manager is unavailable (session module did not register).');
  instance = factory();
  return instance;
}

/** The manager if one was created already, else null. Never imports or launches. */
export function peekBrowserManager(): BrowserManager | null {
  return instance;
}

/** Test hook: inject a fake manager (or null to reset). */
export function setBrowserManagerForTests(m: BrowserManager | null): void {
  instance = m;
}
