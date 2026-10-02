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

export interface BrowserConfig {
  /** Run headless. Default true; QODEX_BROWSER_HEADED=1 or `qodex browser open` flips it. */
  headless: boolean;
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
  /** Reduce automation fingerprints (navigator.webdriver etc). Default true. */
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
  profile: 'default',
  executablePath: '',
  channel: '',
  cdpUrl: '',
  viewport: { width: 1280, height: 800 },
  userAgent: '',
  locale: '',
  timezone: '',
  stealth: true,
  actionTimeoutMs: 8000,
  snapshotMaxChars: 12000,
  snapshotAfterAction: true,
  dialogPolicy: 'accept',
  agentMaxSteps: 40,
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

export function resolveBrowserConfig(cfg: unknown, env: NodeJS.ProcessEnv = process.env): BrowserConfig {
  const s = section(cfg, 'browser');
  const d = DEFAULT_BROWSER_CONFIG;
  const vp = isObj(s.viewport) ? s.viewport : {};
  let headless = bool(s.headless, d.headless);
  if (env.QODEX_BROWSER_HEADED === '1') headless = false;
  if (env.QODEX_BROWSER_HEADLESS === '1') headless = true;
  return {
    headless,
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
