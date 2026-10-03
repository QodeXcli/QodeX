/**
 * Config sections for QodeX's agent platform: dedicated browser, desktop control,
 * Sentinel guard, missions, control center and messaging channels.
 *
 * These sections are OPTIONAL in ~/.qodex/config.yaml. Defaults live here in code
 * (not in DEFAULT_CONFIG) so `qx setup` never freezes today's defaults into the
 * user's YAML. Every resolver is total: it accepts `null`/garbage and always
 * returns a fully-populated object — loadConfig does no validation, so consumers
 * must never trust the raw shape.
 *
 * Usage:
 *   import { resolveBrowserConfig } from '../config/agent-config.js';
 *   const cfg = resolveBrowserConfig(getActiveConfig());
 */

import { resolveBotAuthConfig, DEFAULT_BOT_AUTH_CONFIG, type BotAuthConfig } from '../tools/browser/bot-auth.js';

export interface BrowserConfig {
  /**
   * Run headless — resolved from `headlessMode`. `browser.headless: auto` (the default)
   * is a visible window when a display exists AND a human is at the terminal (the TUI),
   * headless for --print, missions, schedules and display-less machines. A real visible
   * browser is challenged far less often than a headless one. QODEX_BROWSER_HEADLESS=1
   * forces headless, QODEX_BROWSER_HEADED=1 a window; `qodex browser open` opens one.
   */
  headless: boolean;
  /** What was configured: 'auto' (default), 'headless' (headless: true) or 'headed' (headless: false). */
  headlessMode: 'auto' | 'headless' | 'headed';
  /** Named persistent profile (cookies, logins, localStorage survive restarts). */
  profile: string;
  /** Explicit Chromium/Chrome executable. Empty = auto-discover. */
  executablePath: string;
  /** Browser channel when no executable is found ('chrome', 'msedge', ...). Empty = none. */
  channel: string;
  /** Attach to an already-running Chrome over CDP (e.g. http://127.0.0.1:9222) instead of launching. */
  cdpUrl: string;
  viewport: { width: number; height: number };
  /** Override the user agent. Empty = the real browser's UA (no fake Mac UA). */
  userAgent: string;
  /** Locale / timezone presented to sites. Empty = system default. */
  locale: string;
  timezone: string;
  /** Off — QodeX does not hide that it is automated. Only an explicit user setting turns it on. */
  stealth: boolean;
  /** Default action timeout in ms for click/type/etc. */
  actionTimeoutMs: number;
  /** Max chars of the accessibility snapshot returned to the model. */
  snapshotMaxChars: number;
  /** Return a compact snapshot after every browser action (saves a round-trip). */
  snapshotAfterAction: boolean;
  /** Auto-accept/dismiss JS dialogs: 'accept' | 'dismiss' | 'ask'. */
  dialogPolicy: 'accept' | 'dismiss' | 'ask';
  /** Upper bound of steps for the autonomous browser_agent sub-agent. */
  agentMaxSteps: number;
  /**
   * A CAPTCHA / bot check that clears by itself (Cloudflare's "Just a moment…", an
   * Akamai / DataDome / AWS WAF interstitial) is waited out for up to this many seconds
   * after a navigation or action, without model calls. 0 = report it at once.
   */
  challengeAutoWaitSec: number;
  /**
   * What happens with a challenge that needs a person. 'auto': the result says
   * [CHALLENGE] and the agent hands the browser to the human (browser_request_human),
   * resuming by itself when it is gone. 'report': only reported — the agent tells the
   * user. 'off': no detection. QodeX never solves challenges in any mode.
   */
  challengeHandoff: 'auto' | 'report' | 'off';
  /** How long a hand-off waits for the human (s). Default sentinel.remoteApprovalTimeoutSec (600). */
  handoffTimeoutSec: number;
  /** Lifetime of a hand-off's one-time control-center link (s); never longer than handoffTimeoutSec. */
  handoffLinkTtlSec: number;
  /** Minimum gap between agent navigations / actions on the same public host (ms, ≤1000). Loopback / LAN hosts are never paced. */
  hostPacingMs: number;
  /**
   * Lean mode: the browser skips images, fonts and audio/video so pages load with less
   * memory, CPU and bandwidth (the DOM, scripts, styles, forms and cookies are untouched,
   * and so is the HTTP cache). 'auto' (default) = only when QodeX launched the browser
   * headless — nobody is looking at it; 'on' = also in a visible window; 'off' = never.
   * Never applied to your own Chrome (cdpUrl) or to loopback / LAN pages (dev servers).
   * It switches itself off for the rest of the session as soon as a person or a vision
   * model needs the pixels: a takeover, the live view, a screenshot, a bot check.
   * QODEX_BROWSER_LEAN=1 / 0 forces it on / off.
   */
  lean: 'auto' | 'on' | 'off';
  /**
   * Web Bot Auth (`browser.botAuth`): sign the agent's own requests with an Ed25519 key
   * so a site can recognise QodeX and choose to let it through — an honest identity, not
   * detection evasion. Off by default. See src/tools/browser/bot-auth.ts and
   * `qodex browser bot-auth`.
   */
  botAuth: BotAuthConfig;
}

export interface DesktopConfig {
  /** Master switch for computer_use_* tools. */
  enabled: boolean;
  /** Force a backend instead of auto-detecting: 'macos' | 'x11' | 'wayland' | 'windows' | '' (auto). */
  backend: '' | 'macos' | 'x11' | 'wayland' | 'windows';
  /** Pause between low-level input events (ms). */
  inputDelayMs: number;
  /** Max width of screenshots handed to vision models (downscaled when larger and a scaler exists). */
  screenshotMaxWidth: number;
}

export type SentinelCategory =
  | 'purchase'
  | 'payment'
  | 'send'
  | 'credential'
  | 'delete'
  | 'publish'
  | 'account'
  | 'download'
  | 'upload'
  | 'navigation'
  | 'desktop'
  | 'other';

export interface SentinelConfig {
  /** Master switch. Turning it off removes the guard entirely (not recommended). */
  enabled: boolean;
  /**
   * Categories that ALWAYS need an explicit human answer — never auto-approved by
   * `/auto on`, `--yes`, or scheduled runs. Default: purchase, payment, credential, send.
   */
  requireApproval: SentinelCategory[];
  /** Categories the user pre-approved (skip the prompt). Overrides requireApproval. */
  autoApprove: SentinelCategory[];
  /** Domains the browser may never open (suffix match, e.g. "bank.example"). */
  blockedDomains: string[];
  /** If non-empty, the browser may ONLY open these domains (suffix match). */
  allowedDomains: string[];
  /** Block navigation to private/LAN hosts (127.0.0.1, 10.x, ...). Default false — dev servers live there. */
  blockPrivateNetwork: boolean;
  /** Scan page text returned to the model for prompt-injection and flag it. */
  injectionDefense: boolean;
  /** Append every guarded decision to ~/.qodex/sentinel/audit.jsonl. */
  audit: boolean;
  /** How long (s) an unattended run waits for a remote (control center / Telegram) approval. */
  remoteApprovalTimeoutSec: number;
}

export interface MissionsConfig {
  /** Max parallel steps a mission runs at once. */
  maxConcurrency: number;
  /** Per-step iteration cap (0 = unlimited). */
  stepMaxIterations: number;
  /** Per-step wall clock seconds (0 = unlimited). */
  stepMaxWallSeconds: number;
  /** Total USD a mission may spend before pausing for approval (0 = unlimited). */
  maxCostUsd: number;
  /** Retries per failed step. */
  maxAttempts: number;
  /** Notify (desktop + channels) on milestones. */
  notify: boolean;
}

export interface ControlConfig {
  /** Port for the control center (0 = ephemeral). Default 7420. */
  port: number;
  /** Bind host. 127.0.0.1 = local only; 0.0.0.0 for LAN (token required). */
  host: string;
  /** Live browser screencast quality (JPEG 1-100). */
  screencastQuality: number;
  /** Max screencast frames per second pushed to viewers. */
  screencastMaxFps: number;
}

export interface TelegramConfig {
  /** Env var holding the bot token (stored in ~/.qodex/.env). */
  botTokenEnv: string;
  /** Use a Bot API mirror (e.g. a self-hosted proxy) instead of api.telegram.org. */
  apiBase: string;
  /** Send mission milestones / approvals to paired chats. */
  notify: boolean;
}

export interface AgentPlatformConfig {
  browser: BrowserConfig;
  desktop: DesktopConfig;
  sentinel: SentinelConfig;
  missions: MissionsConfig;
  control: ControlConfig;
  telegram: TelegramConfig;
}

export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  headless: true,
  headlessMode: 'auto',
  profile: 'default',
  executablePath: '',
  channel: '',
  cdpUrl: '',
  viewport: { width: 1280, height: 800 },
  userAgent: '',
  locale: '',
  timezone: '',
  stealth: false,
  actionTimeoutMs: 8000,
  snapshotMaxChars: 12000,
  snapshotAfterAction: true,
  dialogPolicy: 'accept',
  agentMaxSteps: 40,
  challengeAutoWaitSec: 20,
  challengeHandoff: 'auto',
  handoffTimeoutSec: 600,
  handoffLinkTtlSec: 600,
  hostPacingMs: 500,
  lean: 'auto',
  botAuth: DEFAULT_BOT_AUTH_CONFIG,
};

export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  enabled: true,
  backend: '',
  inputDelayMs: 40,
  screenshotMaxWidth: 1600,
};

export const DEFAULT_SENTINEL_CONFIG: SentinelConfig = {
  enabled: true,
  requireApproval: ['purchase', 'payment', 'credential', 'send'],
  autoApprove: [],
  blockedDomains: [],
  allowedDomains: [],
  blockPrivateNetwork: false,
  injectionDefense: true,
  audit: true,
  remoteApprovalTimeoutSec: 600,
};

export const DEFAULT_MISSIONS_CONFIG: MissionsConfig = {
  maxConcurrency: 2,
  stepMaxIterations: 60,
  stepMaxWallSeconds: 1800,
  maxCostUsd: 0,
  maxAttempts: 2,
  notify: true,
};

export const DEFAULT_CONTROL_CONFIG: ControlConfig = {
  port: 7420,
  host: '127.0.0.1',
  screencastQuality: 60,
  screencastMaxFps: 8,
};

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botTokenEnv: 'TELEGRAM_BOT_TOKEN',
  apiBase: 'https://api.telegram.org',
  notify: true,
};

// ── tolerant field readers ───────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function bool(v: unknown, d: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return d;
}
function num(v: unknown, d: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}
function str(v: unknown, d: string): string {
  return typeof v === 'string' ? v : d;
}
function strList(v: unknown, d: string[]): string[] {
  if (!Array.isArray(v)) return [...d];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(s => s.trim());
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return (allowed as readonly unknown[]).includes(v) ? (v as T) : d;
}

const SENTINEL_CATEGORIES: readonly SentinelCategory[] = [
  'purchase', 'payment', 'send', 'credential', 'delete', 'publish', 'account',
  'download', 'upload', 'navigation', 'desktop', 'other',
];
function categoryList(v: unknown, d: SentinelCategory[]): SentinelCategory[] {
  if (!Array.isArray(v)) return [...d];
  return v.filter((x): x is SentinelCategory => (SENTINEL_CATEGORIES as readonly unknown[]).includes(x));
}

function section(cfg: unknown, key: string): Record<string, unknown> {
  if (!isObj(cfg)) return {};
  const s = (cfg as Record<string, unknown>)[key];
  return isObj(s) ? s : {};
}

// ── resolvers ────────────────────────────────────────────────────────────────

/**
 * Can a visible window be shown to someone here? False for opt-out env vars, CI, SSH
 * sessions without a forwarded display, and Linux/BSD without DISPLAY / WAYLAND_DISPLAY.
 * (Same rules as src/artifacts/open-browser.ts canOpenBrowser, kept local: config must
 * not import UI helpers.) PURE.
 */
export function hasDisplay(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (env.QODEX_NO_BROWSER || env.QODEX_NO_OPEN || env.NO_BROWSER) return false;
  if (env.CI) return false;
  const display = !!(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return display;
  if ((env.SSH_CONNECTION || env.SSH_TTY) && !display) return false;
  return true;
}

/** Runtime facts for `browser.headless: auto` (the browser manager passes them at launch). */
export interface BrowserRuntime {
  /** A human sits at this process's terminal (the interactive TUI). */
  interactive?: boolean;
  platform?: string;
}

export function resolveBrowserConfig(cfg: unknown, env: NodeJS.ProcessEnv = process.env, runtime: BrowserRuntime = {}): BrowserConfig {
  const s = section(cfg, 'browser');
  const d = DEFAULT_BROWSER_CONFIG;
  const vp = isObj(s.viewport) ? s.viewport : {};
  let headlessMode: BrowserConfig['headlessMode'] =
    s.headless === undefined || s.headless === null || s.headless === 'auto' ? 'auto' : bool(s.headless, true) ? 'headless' : 'headed';
  if (env.QODEX_BROWSER_HEADED === '1') headlessMode = 'headed';
  if (env.QODEX_BROWSER_HEADLESS === '1') headlessMode = 'headless';
  const headless = headlessMode === 'auto'
    ? !(runtime.interactive === true && hasDisplay(env, runtime.platform ?? process.platform))
    : headlessMode === 'headless';
  const sentinelTimeout = num(section(cfg, 'sentinel').remoteApprovalTimeoutSec, DEFAULT_SENTINEL_CONFIG.remoteApprovalTimeoutSec, 5, 86_400);
  const handoffTimeoutSec = num(s.handoffTimeoutSec, sentinelTimeout, 30, 86_400);
  return {
    headless,
    headlessMode,
    profile: str(env.QODEX_BROWSER_PROFILE || s.profile, d.profile) || d.profile,
    executablePath: str(env.QODEX_BROWSER_EXECUTABLE || s.executablePath, d.executablePath),
    channel: str(s.channel, d.channel),
    cdpUrl: str(env.QODEX_BROWSER_CDP_URL || s.cdpUrl, d.cdpUrl),
    viewport: {
      width: num(vp.width, d.viewport.width, 320, 7680),
      height: num(vp.height, d.viewport.height, 240, 4320),
    },
    userAgent: str(s.userAgent, d.userAgent),
    locale: str(s.locale, d.locale),
    timezone: str(s.timezone, d.timezone),
    stealth: bool(s.stealth, d.stealth),
    actionTimeoutMs: num(s.actionTimeoutMs, d.actionTimeoutMs, 500, 120_000),
    snapshotMaxChars: num(s.snapshotMaxChars, d.snapshotMaxChars, 1000, 200_000),
    snapshotAfterAction: bool(s.snapshotAfterAction, d.snapshotAfterAction),
    dialogPolicy: oneOf(s.dialogPolicy, ['accept', 'dismiss', 'ask'] as const, d.dialogPolicy),
    agentMaxSteps: num(s.agentMaxSteps, d.agentMaxSteps, 1, 500),
    challengeAutoWaitSec: num(s.challengeAutoWaitSec, d.challengeAutoWaitSec, 0, 120),
    challengeHandoff: oneOf(s.challengeHandoff, ['auto', 'report', 'off'] as const, d.challengeHandoff),
    handoffTimeoutSec,
    handoffLinkTtlSec: Math.min(handoffTimeoutSec, num(s.handoffLinkTtlSec, Math.min(d.handoffLinkTtlSec, handoffTimeoutSec), 60, 86_400)),
    hostPacingMs: num(s.hostPacingMs, d.hostPacingMs, 0, 1000),
    lean: env.QODEX_BROWSER_LEAN === '1' ? 'on' : env.QODEX_BROWSER_LEAN === '0' ? 'off'
      : s.lean === true ? 'on' : s.lean === false ? 'off' : oneOf(s.lean, ['auto', 'on', 'off'] as const, d.lean),
    botAuth: resolveBotAuthConfig(s.botAuth, env),
  };
}

export function resolveDesktopConfig(cfg: unknown): DesktopConfig {
  const s = section(cfg, 'desktop');
  const d = DEFAULT_DESKTOP_CONFIG;
  return {
    enabled: bool(s.enabled, d.enabled),
    backend: oneOf(s.backend, ['', 'macos', 'x11', 'wayland', 'windows'] as const, d.backend),
    inputDelayMs: num(s.inputDelayMs, d.inputDelayMs, 0, 5000),
    screenshotMaxWidth: num(s.screenshotMaxWidth, d.screenshotMaxWidth, 320, 7680),
  };
}

export function resolveSentinelConfig(cfg: unknown): SentinelConfig {
  const s = section(cfg, 'sentinel');
  const d = DEFAULT_SENTINEL_CONFIG;
  return {
    enabled: bool(s.enabled, d.enabled),
    requireApproval: categoryList(s.requireApproval, d.requireApproval),
    autoApprove: categoryList(s.autoApprove, d.autoApprove),
    blockedDomains: strList(s.blockedDomains, d.blockedDomains).map(x => x.toLowerCase()),
    allowedDomains: strList(s.allowedDomains, d.allowedDomains).map(x => x.toLowerCase()),
    blockPrivateNetwork: bool(s.blockPrivateNetwork, d.blockPrivateNetwork),
    injectionDefense: bool(s.injectionDefense, d.injectionDefense),
    audit: bool(s.audit, d.audit),
    remoteApprovalTimeoutSec: num(s.remoteApprovalTimeoutSec, d.remoteApprovalTimeoutSec, 5, 86_400),
  };
}

export function resolveMissionsConfig(cfg: unknown): MissionsConfig {
  const s = section(cfg, 'missions');
  const d = DEFAULT_MISSIONS_CONFIG;
  return {
    maxConcurrency: num(s.maxConcurrency, d.maxConcurrency, 1, 16),
    stepMaxIterations: num(s.stepMaxIterations, d.stepMaxIterations, 0, 10_000),
    stepMaxWallSeconds: num(s.stepMaxWallSeconds, d.stepMaxWallSeconds, 0, 7 * 86_400),
    maxCostUsd: num(s.maxCostUsd, d.maxCostUsd, 0, 1_000_000),
    maxAttempts: num(s.maxAttempts, d.maxAttempts, 1, 10),
    notify: bool(s.notify, d.notify),
  };
}

export function resolveControlConfig(cfg: unknown): ControlConfig {
  const s = section(cfg, 'control');
  const d = DEFAULT_CONTROL_CONFIG;
  return {
    port: num(s.port, d.port, 0, 65535),
    host: str(s.host, d.host) || d.host,
    screencastQuality: num(s.screencastQuality, d.screencastQuality, 1, 100),
    screencastMaxFps: num(s.screencastMaxFps, d.screencastMaxFps, 1, 30),
  };
}

export function resolveTelegramConfig(cfg: unknown): TelegramConfig {
  const s = section(cfg, 'telegram');
  const d = DEFAULT_TELEGRAM_CONFIG;
  return {
    botTokenEnv: str(s.botTokenEnv, d.botTokenEnv) || d.botTokenEnv,
    apiBase: (str(s.apiBase, d.apiBase) || d.apiBase).replace(/\/+$/, ''),
    notify: bool(s.notify, d.notify),
  };
}

export function resolveAgentPlatformConfig(cfg: unknown, env: NodeJS.ProcessEnv = process.env): AgentPlatformConfig {
  return {
    browser: resolveBrowserConfig(cfg, env),
    desktop: resolveDesktopConfig(cfg),
    sentinel: resolveSentinelConfig(cfg),
    missions: resolveMissionsConfig(cfg),
    control: resolveControlConfig(cfg),
    telegram: resolveTelegramConfig(cfg),
  };
}
