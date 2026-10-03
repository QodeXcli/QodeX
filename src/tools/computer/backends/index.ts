/**
 * Desktop backend selection + per-process desktop state.
 *
 * Selection (config `desktop.backend` overrides auto-detection):
 *   darwin → macos · win32 → windows ·
 *   linux/*bsd → wayland when WAYLAND_DISPLAY is set and DISPLAY is not, else x11.
 * A backend instance is created per tool call (cheap: no state) so each call
 * carries its own AbortSignal; tests replace it with `setDesktopBackendForTests`.
 *
 * Coordinate mapping: tools take coordinates in the pixels of the LAST
 * screenshot the model saw (computer_use_screenshot / computer_use_locate).
 * That screenshot's scale (Retina ×2, downscaling) and origin (window captures)
 * are remembered here, and `toScreenPoint` converts model coordinates into the
 * logical coordinates backends use.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { QODEX_SCREENSHOTS_DIR } from '../../../config/paths.js';
import type { DesktopConfig } from '../../../config/agent-config.js';
import { windowLabel, type BackendDeps, type DesktopBackend, type DesktopBackendName, type Point, type ScreenshotResult } from './types.js';
import { MacosBackend } from './macos.js';
import { X11Backend } from './x11.js';
import { WaylandBackend } from './wayland.js';
import { WindowsBackend } from './windows.js';

export * from './types.js';
export { MacosBackend } from './macos.js';
export { X11Backend } from './x11.js';
export { WaylandBackend } from './wayland.js';
export { WindowsBackend } from './windows.js';

/** Pick a backend for a platform/env. Returns null when the OS has none. PURE. */
export function selectBackendName(
  platform: NodeJS.Platform | string,
  env: NodeJS.ProcessEnv,
  configured: DesktopConfig['backend'] | '' = '',
): DesktopBackendName | null {
  if (configured) return configured;
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd' || platform === 'netbsd') {
    return env.WAYLAND_DISPLAY && !env.DISPLAY ? 'wayland' : 'x11';
  }
  return null;
}

export function createDesktopBackend(name: DesktopBackendName, deps: BackendDeps): DesktopBackend {
  switch (name) {
    case 'macos': return new MacosBackend(deps);
    case 'x11': return new X11Backend(deps);
    case 'wayland': return new WaylandBackend(deps);
    case 'windows': return new WindowsBackend(deps);
  }
}

let testBackend: DesktopBackend | null = null;

/** Tests: force every desktop tool to use this backend (null restores detection). */
export function setDesktopBackendForTests(b: DesktopBackend | null): void {
  testBackend = b;
}

/**
 * The backend for this process, or null on an OS without desktop support.
 * `signal` aborts the backend's in-flight commands.
 */
export function getDesktopBackend(cfg: DesktopConfig, opts: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): DesktopBackend | null {
  if (testBackend) return testBackend;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const name = selectBackendName(platform, env, cfg.backend);
  if (!name) return null;
  return createDesktopBackend(name, { env, platform, inputDelayMs: cfg.inputDelayMs, signal: opts.signal });
}

// ── screenshot → input coordinate mapping ────────────────────────────────────

export interface CaptureMapping {
  path: string;
  width: number;
  height: number;
  scale: number;
  origin: Point;
  backend: string;
  /** Captured window as a sanitized "app: title" label (titles are untrusted; this is echoed in errors). */
  window?: string;
  ts: number;
}

let lastCapture: CaptureMapping | null = null;

/** The element the last computer_use_locate found, in pixels of the capture it was found in. */
export interface LocatedElement {
  description: string;
  x: number;
  y: number;
  box?: { x: number; y: number; w: number; h: number };
  /** `ts` of the CaptureMapping the coordinates belong to. */
  captureTs: number;
}

let lastLocated: LocatedElement | null = null;

export function rememberCapture(shot: ScreenshotResult, backend: string): CaptureMapping {
  lastLocated = null; // a new screenshot is the new coordinate reference
  lastCapture = {
    path: shot.path,
    width: shot.width,
    height: shot.height,
    scale: shot.scale > 0 && Number.isFinite(shot.scale) ? shot.scale : 1,
    origin: { ...shot.origin },
    backend,
    window: shot.window ? windowLabel(shot.window) : undefined,
    ts: Date.now(),
  };
  return lastCapture;
}

export function getLastCapture(): CaptureMapping | null {
  return lastCapture;
}

/** Tests / backend switches: forget the last screenshot mapping. */
export function resetDesktopState(): void {
  lastCapture = null;
  lastLocated = null;
}

/** Record what computer_use_locate found in the CURRENT capture. */
export function rememberLocated(el: Omit<LocatedElement, 'captureTs'>): void {
  if (!lastCapture) return;
  lastLocated = { ...el, description: el.description.replace(/\s+/g, ' ').trim().slice(0, 120), captureTs: lastCapture.ts };
}

/**
 * The description of the located element at (x, y) — screenshot pixels of the
 * current capture — or null. Lets a click carry WHAT it clicks ("Place order
 * button") so the approval prompt / Sentinel and the activity timeline can show
 * it instead of bare coordinates. PURE given the module state.
 */
export function describeDesktopPoint(x: number, y: number): string | null {
  const el = lastLocated;
  if (!el || !lastCapture || el.captureTs !== lastCapture.ts) return null;
  const tol = 4;
  if (el.box) {
    const b = el.box;
    if (x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol) return el.description;
    return null;
  }
  return Math.hypot(x - el.x, y - el.y) <= 12 ? el.description : null;
}

export interface MappedPoint extends Point {
  /** False when no screenshot was taken yet (identity mapping). */
  mapped: boolean;
}

/** Screenshot pixels → logical screen coordinates. PURE given the mapping. */
export function toScreenPoint(x: number, y: number, m: CaptureMapping | null = lastCapture): MappedPoint {
  if (!m) return { x: Math.round(x), y: Math.round(y), mapped: false };
  return {
    x: Math.round(m.origin.x + x / m.scale),
    y: Math.round(m.origin.y + y / m.scale),
    mapped: true,
  };
}

/** Logical screen coordinates → pixels of the last screenshot. PURE given the mapping. */
export function toScreenshotPoint(x: number, y: number, m: CaptureMapping | null = lastCapture): Point {
  if (!m) return { x: Math.round(x), y: Math.round(y) };
  return { x: Math.round((x - m.origin.x) * m.scale), y: Math.round((y - m.origin.y) * m.scale) };
}

/**
 * Reject coordinates outside the last screenshot — almost always a
 * hallucinated or stale coordinate. Returns an error string or null.
 */
export function checkInScreenshot(x: number, y: number, m: CaptureMapping | null = lastCapture): string | null {
  if (!m) return null;
  const tol = 2;
  if (x < -tol || y < -tol || x > m.width + tol || y > m.height + tol) {
    return `(${Math.round(x)}, ${Math.round(y)}) is outside the last screenshot (${m.width}×${m.height} px${m.window ? `, window "${m.window}"` : ''}). Coordinates are pixels of the most recent computer_use_screenshot — take a new screenshot or use computer_use_locate.`;
  }
  return null;
}

// ── screenshots dir ──────────────────────────────────────────────────────────

let screenshotsDirOverride: string | null = null;

/** Tests: redirect default screenshot paths away from ~/.qodex. */
export function setDesktopScreenshotsDir(dir: string | null): void {
  screenshotsDirOverride = dir;
}

export function desktopScreenshotsDir(): string {
  return screenshotsDirOverride ?? QODEX_SCREENSHOTS_DIR;
}

const KEEP_SCREENSHOTS = 200;

/** mkdir -p with mode 0700, tightening an existing directory too (POSIX; best-effort). */
async function ensurePrivateDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
  } catch { /* the backend reports a real failure to write */ }
}

/** Default path for a new desktop screenshot. */
export function defaultScreenshotPath(prefix: 'desktop' | 'locate' = 'desktop', ext = 'png'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(desktopScreenshotsDir(), `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
}

/** Keep only the newest KEEP_SCREENSHOTS desktop-/locate- captures in the default dir. Best-effort. */
export async function pruneDesktopScreenshots(dir: string = desktopScreenshotsDir(), keep = KEEP_SCREENSHOTS): Promise<number> {
  try {
    const stamp = (f: string) => f.replace(/^(desktop|locate)-/i, '');
    const files = (await fs.readdir(dir))
      .filter(f => /^(desktop|locate)-.*\.(png|jpe?g)$/i.test(f))
      .sort((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : 0));
    const doomed = files.slice(0, Math.max(0, files.length - keep));
    await Promise.all(doomed.map(f => fs.rm(path.join(dir, f), { force: true }).catch(() => {})));
    return doomed.length;
  } catch {
    return 0;
  }
}

/**
 * Take a screenshot with `backend`, remember its coordinate mapping, and prune
 * old default captures. `dest` must be absolute.
 */
export async function captureScreenshot(
  backend: DesktopBackend,
  opts: { dest: string; window?: string; maxWidth?: number },
): Promise<{ shot: ScreenshotResult; mapping: CaptureMapping }> {
  const inDefaultDir = path.dirname(opts.dest) === desktopScreenshotsDir();
  // Desktop screenshots show whatever is on screen (mail, banking, password managers):
  // keep the default directory private to this user, like the Sentinel audit dir.
  if (inDefaultDir) await ensurePrivateDir(desktopScreenshotsDir());
  const shot = await backend.screenshot({ path: opts.dest, window: opts.window, maxWidth: opts.maxWidth });
  const mapping = rememberCapture(shot, backend.name);
  if (inDefaultDir) await pruneDesktopScreenshots();
  return { shot, mapping };
}
