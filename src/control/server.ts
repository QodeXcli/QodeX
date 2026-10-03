/**
 * QodeX Control Center — a token-gated web UI (node:http + SSE, no dependencies)
 * that lets a human watch and steer the agent from any browser or phone:
 *
 *   - Live:      a JPEG screencast of the agent's dedicated browser, with a
 *                "Take over" switch that pauses the agent's browser actions and
 *                forwards the human's clicks / keys / scrolls / URL bar to the page.
 *   - Approvals: every pending ApprovalBroker request (Sentinel-critical actions,
 *                permission prompts) with one button per option. Registering the
 *                'control' ApprovalChannel is what lets unattended runs route
 *                critical approvals here instead of refusing them.
 *   - Activity:  the process event bus (agent, mission, browser, sentinel events).
 *   - Steer:     a note injected into the running agent at its next iteration.
 *   - Actions:   a pluggable registry (`registerControlAction`) — the missions
 *                integration registers `missions.list`, `missions.cancel`, ...
 *
 * SECURITY: this server can drive a browser that is logged into the user's
 * accounts and can approve purchases. It is therefore ALWAYS token-gated, even on
 * 127.0.0.1 (any web page in any local browser could otherwise reach it):
 *   - `?k=<token>` sets an HttpOnly, SameSite=Strict cookie and bounces to the
 *     same URL without the token (so it never lingers in history / Referer);
 *   - `Authorization: Bearer <token>` is accepted for scripts and tests;
 *   - tokens are compared with crypto.timingSafeEqual (over sha256 digests);
 *   - every percent-decode is wrapped (a malformed escape must not crash us);
 *   - state-changing requests need `Content-Type: application/json`, a body of
 *     at most 64KB, and an Origin/Referer (when present) matching the Host;
 *   - the token is never echoed back except in the startup URL returned to the
 *     caller of startControlCenter().
 *
 * One control center per process (a singleton): the TUI's `/control`, the
 * standalone `qodex control` command and a detached mission worker each run
 * their own, showing THEIR process's browser and approvals.
 */

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getBus, type BusEvent, type BusEventInput } from './bus.js';
import { getApprovalBroker, type ApprovalChannel, type ApprovalResult, type PendingApproval } from './approvals.js';
import {
  getBrowserManager,
  peekBrowserManager,
  type BrowserManager,
  type BrowserStatus,
  type HumanInputEvent,
  type ScreencastFrame,
} from '../tools/browser/types.js';
import { resolveControlConfig } from '../config/agent-config.js';
import { getActiveConfig } from '../config/loader.js';
import { lanUrls, makeAccessToken, startTunnel, type TunnelHandle } from '../artifacts/live-share.js';
import { renderDashboard, type DashboardLang } from './dashboard.js';
import { logger } from '../utils/logger.js';

// ── limits ────────────────────────────────────────────────────────────────────

/** Max JSON body for POST/PUT requests. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Max concurrently open SSE streams (events + frames) — a cheap DoS guard. */
const MAX_STREAMS = 48;
/** SSE heartbeat so proxies/tunnels don't drop idle streams. */
const HEARTBEAT_MS = 25_000;
/** Bus events larger than this are sent truncated to viewers. */
const MAX_EVENT_JSON = 32 * 1024;
/** Drop a viewer whose socket buffer grows beyond this (a stalled client). */
const MAX_CLIENT_BUFFER = 4 * 1024 * 1024;
/** How often the frame hub re-checks whether a browser is running. */
const FRAME_POLL_MS = 1500;
/** Back-off after a failed startScreencast before retrying. */
const FRAME_RETRY_MS = 5000;
const COOKIE_PREFIX = 'qx_ctl';
const COOKIE_MAX_AGE_S = 7 * 24 * 3600;

// ── public types ──────────────────────────────────────────────────────────────

export type SteerHandler = (note: string) => boolean | Promise<boolean>;
export type ControlActionHandler = (body: unknown) => unknown | Promise<unknown>;

export interface ControlCenterOptions {
  /** Port to listen on (default: config control.port, 7420). Falls back to a free port when busy. 0 = ephemeral. */
  port?: number;
  /** Bind address (default: config control.host, 127.0.0.1; `lan` forces 0.0.0.0). */
  host?: string;
  /** Access token (16+ URL-safe chars). Default: $QODEX_CONTROL_TOKEN or a fresh random token. */
  token?: string;
  /** Serve on the local network too (binds 0.0.0.0 and reports LAN URLs). */
  lan?: boolean;
  /** Open a public quick tunnel (cloudflared → ngrok). Soft-fails into `tunnelError`. */
  tunnel?: boolean;
  /** Dashboard title. */
  title?: string;
  /** Force the dashboard language (default: from the viewer's Accept-Language). */
  lang?: DashboardLang;
  /** How steering notes reach the agent. Default: the active AgentLoop of this process. */
  onSteer?: SteerHandler;
  /** Screencast JPEG quality / fps (default: config control.screencastQuality / screencastMaxFps). */
  screencastQuality?: number;
  screencastMaxFps?: number;
}

export interface ControlCenterInfo {
  /** Owner URL (loopback, carries the token). */
  url: string;
  port: number;
  token: string;
  /** Every shareable URL: owner + LAN (when bound to all interfaces) + tunnel (when up). */
  urls: string[];
  tunnelUrl?: string;
  tunnelError?: string;
  host: string;
  lan: boolean;
  title: string;
  startedAt: number;
  /** Open dashboard streams (events + frames). */
  viewers: number;
}

// ── control actions registry ──────────────────────────────────────────────────

const ACTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const actions = new Map<string, ControlActionHandler>();

/**
 * Register a named action callable from the dashboard / scripts as
 * `POST /api/actions/<name>` with a JSON body. Returns an unregister function.
 * Conventions used by the dashboard: `missions.list` ({limit?}) → Mission[],
 * `missions.cancel` ({id}), `missions.start` ({goal, cwd?}), `missions.approvals`
 * () → [{id, missionId, prompt, options, category?}], `missions.resolveApproval`
 * ({id, answer, by}).
 */
export function registerControlAction(name: string, handler: ControlActionHandler): () => void {
  if (!ACTION_NAME_RE.test(String(name ?? ''))) {
    throw new Error(`[INVALID_ACTION_NAME] "${String(name)}" — use letters, digits and . _ : - (max 64 chars).`);
  }
  if (typeof handler !== 'function') throw new Error(`[INVALID_ACTION_HANDLER] ${name}: handler must be a function.`);
  actions.set(name, handler);
  announceActions();
  return () => {
    if (actions.get(name) === handler) {
      actions.delete(name);
      announceActions();
    }
  };
}

/** Names of the registered control actions, sorted. */
export function listControlActions(): string[] {
  return [...actions.keys()].sort();
}

/** Invoke a registered control action in-process (same semantics as the HTTP route). */
export async function runControlAction(name: string, body: unknown = {}): Promise<unknown> {
  const h = actions.get(name);
  if (!h) throw new Error(`[UNKNOWN_ACTION] No control action named "${name}". Registered: ${listControlActions().join(', ') || '(none)'}`);
  return await h(body);
}

function announceActions(): void {
  if (!current) return;
  const json = JSON.stringify({ actions: listControlActions() });
  for (const c of current.eventClients) c.send('actions', json);
}

// ── pure helpers (exported for tests) ─────────────────────────────────────────

/** decodeURIComponent that never throws (malformed escapes → null). */
export function safeDecode(s: string, plusAsSpace = false): string | null {
  try {
    return decodeURIComponent(plusAsSpace ? s.replace(/\+/g, ' ') : s);
  } catch {
    return null;
  }
}

/** Split a raw request URL into its (undecoded) path and query string. */
export function splitUrl(raw: string): { path: string; query: string } {
  const noHash = String(raw ?? '/').split('#')[0];
  const qi = noHash.indexOf('?');
  return qi >= 0 ? { path: noHash.slice(0, qi) || '/', query: noHash.slice(qi + 1) } : { path: noHash || '/', query: '' };
}

/** Value of query parameter `name` (decoded), or null when absent/malformed. */
export function queryParam(query: string, name: string): string | null {
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = safeDecode(eq >= 0 ? part.slice(0, eq) : part, true);
    if (k !== name) continue;
    return eq >= 0 ? safeDecode(part.slice(eq + 1), true) : '';
  }
  return null;
}

/** Parse a Cookie header into name → decoded value (malformed values are skipped). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = safeDecode(part.slice(eq + 1).trim());
    if (name && value !== null && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** Constant-time token comparison (sha256 digests so lengths never leak). */
export function tokenMatches(expected: string, candidate: string | null | undefined): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || !expected) return false;
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(candidate, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Cookie name for a control center on `port`. Cookies are NOT port-isolated, so a
 *  TUI control center and a mission worker's on the same host must not share one. */
export function controlCookieName(port: number): string {
  return `${COOKIE_PREFIX}_${port}`;
}

export type ControlAuth = { ok: false } | { ok: true; via: 'query' | 'bearer' | 'cookie' };

/** Decide whether a request carries the access token, and how. PURE. */
export function authenticateRequest(token: string, port: number, req: { url?: string; headers: IncomingHttpHeaders }): ControlAuth {
  const { query } = splitUrl(req.url ?? '/');
  if (query && tokenMatches(token, queryParam(query, 'k'))) return { ok: true, via: 'query' };
  const authz = req.headers.authorization;
  if (typeof authz === 'string') {
    const m = authz.match(/^\s*Bearer\s+(\S+)\s*$/i);
    if (m && tokenMatches(token, m[1])) return { ok: true, via: 'bearer' };
  }
  const cookies = parseCookies(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined);
  for (const name of [controlCookieName(port), COOKIE_PREFIX]) {
    if (tokenMatches(token, cookies.get(name))) return { ok: true, via: 'cookie' };
  }
  return { ok: false };
}

/**
 * The URL to bounce to after a `?k=` login: same path + query minus `k`. Anything
 * that could be read as another origin (`//evil`, `/\evil`, no leading slash) is
 * replaced by `/` — never an open redirect.
 */
export function stripTokenFromUrl(raw: string): string {
  const { path, query } = splitUrl(raw);
  const safePath = path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !/[\u0000-\u001f\u007f]/.test(path)
    ? path
    : '/';
  const kept = query.split('&').filter(part => part && !/^k(=|$)/.test(part) && !/[\u0000-\u001f\u007f]/.test(part));
  return kept.length ? `${safePath}?${kept.join('&')}` : safePath;
}

/** Same-origin check for state-changing requests: Origin (or Referer) must match the
 *  Host (or X-Forwarded-Host set by a tunnel). Absent both headers → allowed (scripts). */
export function originAllowed(headers: IncomingHttpHeaders): boolean {
  const normHost = (h: string) => h.trim().toLowerCase().replace(/:(80|443)$/, '');
  const host = normHost(String(headers.host ?? ''));
  const fwdRaw = headers['x-forwarded-host'];
  const fwd = normHost(String(Array.isArray(fwdRaw) ? fwdRaw[0] : fwdRaw ?? '').split(',')[0] ?? '');
  const matches = (value: string): boolean => {
    let u: URL;
    try { u = new URL(value); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = normHost(u.host);
    return (!!host && h === host) || (!!fwd && h === fwd);
  };
  const origin = headers.origin;
  if (origin !== undefined) return matches(String(origin));
  const referer = headers.referer;
  if (referer !== undefined) return matches(String(referer));
  return true;
}

/**
 * Normalize a URL typed into the dashboard's URL bar. Only http(s) and about:blank
 * are allowed (no javascript:, file:, chrome:, data: ...). A scheme-less host gets
 * https:// (http:// for localhost / private addresses). Returns null when invalid.
 */
export function normalizeNavigateUrl(input: string): string | null {
  const s = String(input ?? '').trim();
  if (!s || s.length > 4096 || /[\u0000-\u0020\u007f]/.test(s)) return null;
  if (/^about:blank$/i.test(s)) return 'about:blank';
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
    || /^(javascript|data|file|blob|about|chrome|chrome-extension|edge|view-source|vbscript|mailto|tel|intent|ws|wss|ftp):/i.test(s);
  let candidate = s;
  if (!hasScheme) {
    const hostPart = (s.split(/[/?#]/)[0] ?? '').toLowerCase();
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/.test(hostPart)
      || /\.(local|localhost|internal|lan)(:\d+)?$/.test(hostPart);
    candidate = (local ? 'http://' : 'https://') + s;
  }
  let u: URL;
  try { u = new URL(candidate); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.href;
}

function finiteIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/**
 * Validate a HumanInputEvent posted by the dashboard and copy ONLY the known
 * fields (nothing else from the body ever reaches the browser manager).
 */
export function validateHumanInput(body: unknown): { ok: true; event: HumanInputEvent } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const type = b.type;
  const COORD = 100_000;
  const frame = (): { frameWidth?: number; frameHeight?: number } | string => {
    const out: { frameWidth?: number; frameHeight?: number } = {};
    if (b.frameWidth !== undefined) {
      if (!finiteIn(b.frameWidth, 1, COORD)) return 'frameWidth must be a positive number';
      out.frameWidth = b.frameWidth;
    }
    if (b.frameHeight !== undefined) {
      if (!finiteIn(b.frameHeight, 1, COORD)) return 'frameHeight must be a positive number';
      out.frameHeight = b.frameHeight;
    }
    return out;
  };
  switch (type) {
    case 'click': {
      if (!finiteIn(b.x, 0, COORD) || !finiteIn(b.y, 0, COORD)) return { ok: false, error: 'click needs numeric x and y' };
      const f = frame();
      if (typeof f === 'string') return { ok: false, error: f };
      const ev: HumanInputEvent = { type: 'click', x: b.x, y: b.y, ...f };
      if (b.button !== undefined) {
        if (b.button !== 'left' && b.button !== 'right' && b.button !== 'middle') return { ok: false, error: 'button must be left, right or middle' };
        ev.button = b.button;
      }
      if (b.clickCount !== undefined) {
        if (!finiteIn(b.clickCount, 1, 3)) return { ok: false, error: 'clickCount must be 1-3' };
        ev.clickCount = Math.round(b.clickCount);
      }
      return { ok: true, event: ev };
    }
    case 'move': {
      if (!finiteIn(b.x, 0, COORD) || !finiteIn(b.y, 0, COORD)) return { ok: false, error: 'move needs numeric x and y' };
      const f = frame();
      if (typeof f === 'string') return { ok: false, error: f };
      return { ok: true, event: { type: 'move', x: b.x, y: b.y, ...f } };
    }
    case 'scroll': {
      if (!finiteIn(b.dx, -COORD, COORD) || !finiteIn(b.dy, -COORD, COORD)) return { ok: false, error: 'scroll needs numeric dx and dy' };
      const f = frame();
      if (typeof f === 'string') return { ok: false, error: f };
      const ev: HumanInputEvent = { type: 'scroll', dx: b.dx, dy: b.dy, ...f };
      if (b.x !== undefined || b.y !== undefined) {
        if (!finiteIn(b.x, 0, COORD) || !finiteIn(b.y, 0, COORD)) return { ok: false, error: 'scroll x/y must be numbers' };
        ev.x = b.x;
        ev.y = b.y;
      }
      return { ok: true, event: ev };
    }
    case 'type': {
      if (typeof b.text !== 'string' || b.text.length === 0 || b.text.length > 10_000) return { ok: false, error: 'type needs text (1-10000 chars)' };
      return { ok: true, event: { type: 'type', text: b.text } };
    }
    case 'key': {
      if (typeof b.key !== 'string' || b.key.length === 0 || b.key.length > 64 || /[\u0000-\u001f\u007f]/.test(b.key)) {
        return { ok: false, error: 'key needs a key name such as "Enter" or "Control+a"' };
      }
      return { ok: true, event: { type: 'key', key: b.key } };
    }
    case 'navigate': {
      const url = normalizeNavigateUrl(typeof b.url === 'string' ? b.url : '');
      if (!url) return { ok: false, error: 'navigate needs an http(s) URL' };
      return { ok: true, event: { type: 'navigate', url } };
    }
    case 'back':
    case 'forward':
    case 'reload':
      return { ok: true, event: { type } };
    default:
      return { ok: false, error: 'type must be one of click, move, scroll, type, key, navigate, back, forward, reload' };
  }
}

/** JSON.stringify that never throws (bigint, cycles, functions, AbortSignal). */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const out = JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'function' || typeof v === 'symbol') return undefined;
      if (v && typeof v === 'object') {
        if (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal) return undefined;
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    });
    return out ?? 'null';
  } catch {
    return '{"error":"unserializable"}';
  }
}

/** Wire form of a bus event (truncated when huge, so one event can't flood viewers). */
export function busEventJson(ev: BusEvent): string {
  const s = safeStringify(ev);
  if (s.length <= MAX_EVENT_JSON) return s;
  const head: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev as unknown as Record<string, unknown>)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      head[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v;
    }
  }
  return safeStringify({ ...head, truncated: true, preview: s.slice(0, 2000) });
}

/**
 * Mask secret-looking substrings in free text shown on the dashboard (tool output
 * summaries can contain keys read from files). Key-based redaction (utils/redact)
 * can't see inside free text, so this catches the common token shapes.
 */
export function maskSecrets(text: string): string {
  return String(text ?? '')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '$1-***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***')
    .replace(/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, 'xox*-***')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '***:***')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+\/=-]{6,}/gi, '$1 ***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, 'eyJ***')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization|bearer)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1***');
}

function clipText(v: unknown, n: number): string {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
  const one = s.replace(/\s+/g, ' ').trim();
  return maskSecrets(one.length > n ? one.slice(0, n - 1) + '…' : one);
}

/**
 * Compact an AgentLoop event into a bus event for the dashboard's Activity
 * timeline — or null for high-volume noise (text/argument deltas, budget ticks,
 * tool_ui). Tool output is reduced to a short, secret-masked first line, so page
 * text and file contents never flood (or leak through) remote viewers.
 *
 * Integration: `for await (const ev of agent.run(...)) { publishAgentEvent('tui', ev); ... }`.
 */
export function agentEventToBus(source: string, ev: { type: string; data?: unknown }): BusEventInput | null {
  if (!ev || typeof ev.type !== 'string') return null;
  const d = (ev.data && typeof ev.data === 'object' && !Array.isArray(ev.data) ? ev.data : {}) as Record<string, unknown>;
  const src = String(source || 'agent').slice(0, 80);
  switch (ev.type) {
    case 'tool_call_start':
      return { kind: 'agent', source: src, type: 'tool', data: { tool: clipText(d.name, 80) } };
    case 'tool_result': {
      const firstLine = typeof d.result === 'string' ? (d.result.split('\n').find(l => l.trim()) ?? '') : '';
      return { kind: 'agent', source: src, type: d.isError ? 'tool_error' : 'tool_done', data: { tool: clipText(d.name, 80), summary: clipText(firstLine, 200) } };
    }
    case 'final':
      return { kind: 'agent', source: src, type: 'final', data: { summary: clipText(d.content, 400) } };
    case 'error':
      return { kind: 'agent', source: src, type: 'error', data: { error: clipText(d.message, 400) } };
    case 'notice':
    case 'progress':
      return { kind: 'agent', source: src, type: ev.type, data: { message: clipText(d.message, 300) } };
    case 'steer_injected':
      return { kind: 'agent', source: src, type: 'steer_injected', data: { note: clipText(d.note, 300) } };
    case 'iteration_start':
      return typeof d.iteration === 'number' ? { kind: 'agent', source: src, type: 'step', data: { status: `#${d.iteration}` } } : null;
    default:
      return null;
  }
}

/** Publish an AgentLoop event to the bus (compacted; noise dropped). Never throws. */
export function publishAgentEvent(source: string, ev: { type: string; data?: unknown }): void {
  try {
    const b = agentEventToBus(source, ev);
    if (b) getBus().publish(b);
  } catch { /* never break the agent loop */ }
}

/** Approval as shown to viewers (never the AbortSignal). */
export function publicApproval(p: PendingApproval): Record<string, unknown> {
  return {
    id: p.id,
    prompt: p.prompt,
    options: p.options,
    source: p.source,
    category: p.category,
    risk: p.risk,
    meta: p.meta,
    createdAt: p.createdAt,
    timeoutMs: p.timeoutMs,
  };
}

/** Human-readable summary of a running control center (for the CLI and /control). */
export function describeControlCenter(info: ControlCenterInfo, lang: DashboardLang = 'en'): string {
  const fa = lang === 'fa';
  const lines: string[] = [];
  lines.push(fa ? '🛰  مرکز کنترل QodeX در حال اجراست:' : '🛰  QodeX Control Center is running:');
  lines.push(`   ${fa ? 'باز کردن' : 'Open'}:   ${info.url}`);
  for (const u of info.urls) {
    if (u === info.url || u === info.tunnelUrl) continue;
    lines.push(`   ${fa ? 'شبکه محلی' : 'LAN'}:    ${u}`);
  }
  if (info.tunnelUrl) lines.push(`   ${fa ? 'عمومی' : 'Public'}: ${info.tunnelUrl}`);
  if (info.tunnelError) lines.push(`   ${fa ? 'تونل در دسترس نیست' : 'Tunnel unavailable'}: ${info.tunnelError}`);
  lines.push(fa
    ? '   هر کس این لینک را داشته باشد می‌تواند مرورگر QodeX را ببیند و کنترل کند و به تأییدها پاسخ دهد. آن را خصوصی نگه دارید.'
    : '   Anyone with this link can watch and drive QodeX\'s browser and answer its approvals. Keep it private.');
  return lines.join('\n');
}

// ── SSE plumbing ──────────────────────────────────────────────────────────────

function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.flushHeaders?.();
  res.write('retry: 2000\n\n');
}

class SseClient {
  private readonly heartbeat: NodeJS.Timeout;
  private blocked = false;
  closed = false;

  constructor(private readonly res: ServerResponse, private readonly onClose: () => void) {
    this.heartbeat = setInterval(() => this.raw(': ping\n\n'), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    res.on('close', () => this.dispose());
    res.on('error', () => this.dispose());
    res.on('drain', () => { this.blocked = false; });
  }

  /** Send one event. `droppable` events (frames) are skipped while the socket is congested. */
  send(event: string, json: string, droppable = false): void {
    if (this.closed || (droppable && this.blocked)) return;
    this.raw(`event: ${event}\ndata: ${json}\n\n`);
  }

  private raw(chunk: string): void {
    if (this.closed) return;
    try {
      const ok = this.res.write(chunk);
      if (!ok) {
        this.blocked = true;
        if (this.res.writableLength > MAX_CLIENT_BUFFER) this.end();
      }
    } catch {
      this.dispose();
    }
  }

  end(): void {
    if (!this.closed) {
      try { this.res.end(); } catch { /* already gone */ }
    }
    this.dispose();
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.onClose();
  }
}

// ── live frames ───────────────────────────────────────────────────────────────

/**
 * Fans the browser screencast out to every frame viewer. The screencast runs only
 * while at least one viewer is connected AND a browser is running in this process;
 * the hub follows the browser starting/stopping (bus events + a cheap poll).
 */
class FrameHub {
  readonly viewers = new Set<SseClient>();
  private stopFn: (() => Promise<void>) | null = null;
  private startingGen = 0;
  private gen = 0;
  private live = false;
  private last: { frame: ScreencastFrame; at: number } | null = null;
  private poll: NodeJS.Timeout | null = null;
  private lastFailure = 0;

  constructor(private readonly opts: { quality: number; maxFps: number }) {}

  add(res: ServerResponse): void {
    const client: SseClient = new SseClient(res, () => this.remove(client));
    this.viewers.add(client);
    if (!this.poll) {
      this.poll = setInterval(() => this.sync(), FRAME_POLL_MS);
      this.poll.unref?.();
    }
    if (this.live && this.last) client.send('frame', frameJson(this.last.frame), true);
    else client.send('idle', JSON.stringify({ reason: this.browserRunning() ? 'starting' : 'no-browser' }));
    this.sync();
  }

  private remove(c: SseClient): void {
    this.viewers.delete(c);
    if (this.viewers.size === 0) {
      if (this.poll) { clearInterval(this.poll); this.poll = null; }
      void this.stop();
    }
  }

  private browserRunning(): boolean {
    try {
      const mgr = peekBrowserManager();
      return !!mgr && mgr.isRunning();
    } catch {
      return false;
    }
  }

  /** Start/stop the screencast to match (viewers > 0) && (browser running). */
  sync(): void {
    if (this.viewers.size === 0) return;
    const mgr = peekBrowserManager();
    if (!mgr || !this.browserRunning()) {
      if (this.stopFn || this.live || this.startingGen) {
        void this.stop();
        this.last = null;
        this.broadcastIdle('no-browser');
      }
      return;
    }
    if (this.stopFn || this.startingGen) return;
    if (Date.now() - this.lastFailure < FRAME_RETRY_MS) return;
    this.start(mgr);
  }

  private start(mgr: BrowserManager): void {
    const g = ++this.gen;
    this.startingGen = g;
    let p: Promise<() => Promise<void>>;
    try {
      p = mgr.startScreencast(f => this.onFrame(g, f), { quality: this.opts.quality, maxFps: this.opts.maxFps });
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(stop => {
      if (this.startingGen === g) this.startingGen = 0;
      if (g !== this.gen || this.viewers.size === 0) {
        void Promise.resolve().then(stop).catch(() => {});
        return;
      }
      this.stopFn = stop;
    }).catch(err => {
      if (this.startingGen === g) this.startingGen = 0;
      if (g !== this.gen) return;
      this.lastFailure = Date.now();
      this.broadcastIdle('error', errMessage(err));
    });
  }

  private onFrame(g: number, f: ScreencastFrame): void {
    if (g !== this.gen || !f || typeof f.data !== 'string') return;
    this.last = { frame: f, at: Date.now() };
    this.live = true;
    const json = frameJson(f);
    for (const v of this.viewers) v.send('frame', json, true);
  }

  async stop(): Promise<void> {
    this.gen++;
    this.startingGen = 0;
    this.live = false;
    const s = this.stopFn;
    this.stopFn = null;
    if (s) {
      try { await s(); } catch { /* screencast already gone with its page */ }
    }
  }

  onBrowserEvent(type: string): void {
    if (type === 'closed') {
      void this.stop();
      this.last = null;
      this.broadcastIdle('closed');
      return;
    }
    if (type === 'launched' || type === 'tab') this.sync();
  }

  /** The latest frame if it is fresh enough to serve as a snapshot. */
  latest(maxAgeMs: number): ScreencastFrame | null {
    if (!this.live || !this.last) return null;
    return Date.now() - this.last.at <= maxAgeMs ? this.last.frame : null;
  }

  private broadcastIdle(reason: string, message?: string): void {
    const json = JSON.stringify(message ? { reason, message } : { reason });
    for (const v of this.viewers) v.send('idle', json);
  }

  async close(): Promise<void> {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    for (const v of [...this.viewers]) v.end();
    this.viewers.clear();
    await this.stop();
  }
}

function frameJson(f: ScreencastFrame): string {
  return JSON.stringify({ data: f.data, w: f.width, h: f.height, ts: f.ts });
}

// ── singleton state ───────────────────────────────────────────────────────────

interface Running {
  server: Server;
  sockets: Set<Socket>;
  host: string;
  port: number;
  token: string;
  title: string;
  lang?: DashboardLang;
  lan: boolean;
  startedAt: number;
  quality: number;
  maxFps: number;
  onSteer?: SteerHandler;
  eventClients: Set<SseClient>;
  frames: FrameHub;
  tunnel?: TunnelHandle;
  tunnelUrl?: string;
  tunnelError?: string;
  unregisterChannel: () => void;
  unsubscribeBus: () => void;
}

let current: Running | null = null;
/** Serializes start/stop so concurrent callers never race two servers into existence. */
let opChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => {});
  return run;
}

type TunnelStarter = (port: number) => Promise<TunnelHandle>;
let tunnelStarter: TunnelStarter = (port) => startTunnel(port);

/** Test hook: replace the tunnel launcher (null restores cloudflared/ngrok). */
export function setTunnelStarterForTests(fn: TunnelStarter | null): void {
  tunnelStarter = fn ?? ((port) => startTunnel(port));
}

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Best-effort: don't leave a cloudflared/ngrok child running after QodeX exits.
  process.on('exit', () => {
    try { current?.tunnel?.close(); } catch { /* ignore */ }
  });
}

function errMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 500 ? m.slice(0, 500) + '…' : m;
}

function isWildcardHost(h: string): boolean {
  return h === '0.0.0.0' || h === '::' || h === '';
}

function isLoopbackHost(h: string): boolean {
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || /^127\./.test(h);
}

function resolveToken(t: string | undefined): string {
  const v = String(t ?? process.env.QODEX_CONTROL_TOKEN ?? '').trim();
  if (!v) return makeAccessToken();
  if (!/^[A-Za-z0-9._~-]{16,256}$/.test(v)) {
    throw new Error('[CONTROL_WEAK_TOKEN] The control-center token must be 16-256 URL-safe characters (A-Z a-z 0-9 . _ ~ -).');
  }
  return v;
}

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listenWithFallback(server: Server, port: number, host: string): Promise<number> {
  try {
    await listenOn(server, port, host);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (port !== 0 && (code === 'EADDRINUSE' || code === 'EACCES')) {
      await listenOn(server, 0, host);
    } else {
      throw e;
    }
  }
  const addr = server.address();
  return addr && typeof addr === 'object' ? addr.port : port;
}

function infoOf(rt: Running): ControlCenterInfo {
  const ownerHost = isWildcardHost(rt.host) ? '127.0.0.1' : rt.host.includes(':') ? `[${rt.host}]` : rt.host;
  const url = `http://${ownerHost}:${rt.port}/?k=${rt.token}`;
  const urls = [url];
  if (isWildcardHost(rt.host)) {
    for (const u of lanUrls(rt.port, rt.token)) if (!urls.includes(u)) urls.push(u);
  }
  if (rt.tunnelUrl) urls.push(rt.tunnelUrl);
  return {
    url,
    port: rt.port,
    token: rt.token,
    urls,
    tunnelUrl: rt.tunnelUrl,
    tunnelError: rt.tunnelError,
    host: rt.host,
    lan: rt.lan,
    title: rt.title,
    startedAt: rt.startedAt,
    viewers: rt.eventClients.size + rt.frames.viewers.size,
  };
}

async function openTunnel(rt: Running): Promise<void> {
  try {
    const t = await tunnelStarter(rt.port);
    rt.tunnel = t;
    rt.tunnelUrl = `${t.url.replace(/\/+$/, '')}/?k=${rt.token}`;
    rt.tunnelError = undefined;
  } catch (e) {
    rt.tunnelError = errMessage(e);
  }
}

async function launch(opts: ControlCenterOptions): Promise<Running> {
  const cfg = resolveControlConfig(getActiveConfig());
  const lan = !!opts.lan;
  let host = String(opts.host ?? '').trim() || (lan ? '0.0.0.0' : cfg.host);
  if (lan && isLoopbackHost(host)) host = '0.0.0.0';
  const port = opts.port ?? cfg.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`[CONTROL_BAD_PORT] Invalid port: ${String(opts.port)}`);
  const token = resolveToken(opts.token);
  const quality = Math.round(Math.min(100, Math.max(1, opts.screencastQuality ?? cfg.screencastQuality)));
  const maxFps = Math.min(30, Math.max(1, opts.screencastMaxFps ?? cfg.screencastMaxFps));

  const server = createServer();
  const rt: Running = {
    server,
    sockets: new Set(),
    host,
    port,
    token,
    title: (opts.title ?? '').trim(),
    lang: opts.lang,
    lan: lan || isWildcardHost(host),
    startedAt: Date.now(),
    quality,
    maxFps,
    onSteer: opts.onSteer,
    eventClients: new Set(),
    frames: new FrameHub({ quality, maxFps }),
    unregisterChannel: () => {},
    unsubscribeBus: () => {},
  };

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    handleRequest(rt, req, res).catch(err => {
      logger.warn('Control center request failed', { err: errMessage(err), path: splitUrl(req.url ?? '/').path });
      if (!res.headersSent) sendError(res, 500, `[INTERNAL_ERROR] ${errMessage(err)}`);
      else { try { res.end(); } catch { /* ignore */ } }
    });
  });
  server.on('connection', (s: Socket) => {
    rt.sockets.add(s);
    s.once('close', () => rt.sockets.delete(s));
  });

  rt.port = await listenWithFallback(server, port, host);

  // Human approvals: make this a remote channel so unattended runs can ask here.
  const channel: ApprovalChannel = {
    name: 'control',
    deliver: (p: PendingApproval) => {
      const json = safeStringify(publicApproval(p));
      for (const c of rt.eventClients) c.send('approval', json);
    },
    retract: (id: string, result: ApprovalResult) => {
      const json = safeStringify({ id, answer: result.answer, by: result.by });
      for (const c of rt.eventClients) c.send('approval-retract', json);
    },
  };
  rt.unregisterChannel = getApprovalBroker().registerChannel(channel);

  rt.unsubscribeBus = getBus().subscribe((ev: BusEvent) => {
    if (rt.eventClients.size > 0) {
      const json = busEventJson(ev);
      for (const c of rt.eventClients) c.send('bus', json);
    }
    if (ev.kind === 'browser') rt.frames.onBrowserEvent(ev.type);
  });

  if (opts.tunnel) await openTunnel(rt);
  installExitHook();
  logger.info('Control center started', { host: rt.host, port: rt.port, tunnel: !!rt.tunnelUrl });
  return rt;
}

async function shutdown(rt: Running, releaseTakeover: boolean): Promise<void> {
  try { rt.unregisterChannel(); } catch { /* ignore */ }
  try { rt.unsubscribeBus(); } catch { /* ignore */ }
  await rt.frames.close().catch(() => {});
  for (const c of [...rt.eventClients]) c.end();
  rt.eventClients.clear();
  if (releaseTakeover) {
    // Never leave the agent paused behind a takeover nobody can hand back.
    try {
      const mgr = peekBrowserManager();
      if (mgr?.isTakeover() && mgr.status().takeoverBy === 'control') mgr.setTakeover(false, 'control');
    } catch { /* ignore */ }
  }
  try { rt.tunnel?.close(); } catch { /* ignore */ }
  rt.tunnel = undefined;
  await new Promise<void>(resolve => {
    rt.server.close(() => resolve());
    (rt.server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    for (const s of rt.sockets) { try { s.destroy(); } catch { /* ignore */ } }
  });
  logger.info('Control center stopped', { port: rt.port });
}

/**
 * Start the control center (or return the running one). A second call may upgrade
 * the running server: `lan` rebinds on 0.0.0.0 (same token/port), `tunnel` opens a
 * public link, `title`/`lang`/`onSteer` are updated in place.
 */
export function startControlCenter(opts: ControlCenterOptions = {}): Promise<ControlCenterInfo> {
  return serialize(async () => {
    if (current) {
      const rt = current;
      if (opts.title !== undefined && opts.title.trim()) rt.title = opts.title.trim();
      if (opts.lang) rt.lang = opts.lang;
      if (opts.onSteer) rt.onSteer = opts.onSteer;
      if (opts.lan && !isWildcardHost(rt.host)) {
        // LAN needs an all-interfaces bind: rebind with the same token/port/settings.
        // Open dashboards reconnect on their own; the takeover state is kept.
        const keep: ControlCenterOptions = {
          host: rt.host,
          port: rt.port,
          token: rt.token,
          title: rt.title,
          lang: rt.lang,
          onSteer: rt.onSteer,
          screencastQuality: rt.quality,
          screencastMaxFps: rt.maxFps,
          tunnel: !!rt.tunnel,
        };
        const next: ControlCenterOptions = { ...keep, ...opts, host: '0.0.0.0', lan: true, port: rt.port, token: rt.token, tunnel: !!opts.tunnel || !!rt.tunnel };
        current = null;
        await shutdown(rt, false);
        try {
          current = await launch(next);
        } catch (e) {
          // Don't leave the user without a control center: restore the previous bind.
          current = await launch(keep).catch(() => null);
          throw e;
        }
        return infoOf(current);
      }
      if (opts.tunnel && !rt.tunnel) await openTunnel(rt);
      return infoOf(rt);
    }
    current = await launch(opts);
    return infoOf(current);
  });
}

/** Stop the control center. Resolves true when one was running. */
export function stopControlCenter(): Promise<boolean> {
  return serialize(async () => {
    const rt = current;
    if (!rt) return false;
    current = null;
    await shutdown(rt, true);
    return true;
  });
}

/** Info about the running control center, or null. */
export function getControlCenter(): ControlCenterInfo | null {
  return current ? infoOf(current) : null;
}

// ── request handling ──────────────────────────────────────────────────────────

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

const HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = safeStringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    ...extra,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, error: string, extra: Record<string, string> = {}): void {
  sendJson(res, status, { ok: false, error }, extra);
}

function sendHtml(res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': HTML_CSP,
    'Content-Length': String(Buffer.byteLength(html)),
    ...extra,
  });
  res.end(html);
}

function wantsHtml(req: IncomingMessage): boolean {
  return /text\/html/i.test(String(req.headers.accept ?? ''));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function bouncePage(target: string): string {
  const t = escapeHtml(target);
  const js = JSON.stringify(target).replace(/</g, '\\u003c');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">'
    + `<meta http-equiv="refresh" content="0;url=${t}"><title>QodeX Control Center</title></head>`
    + '<body style="background:#0b0f14;color:#e5e7eb;font-family:system-ui,sans-serif;padding:24px">'
    + `<p>Signing you in… <a style="color:#22d3ee" href="${t}">continue</a></p>`
    + `<script>location.replace(${js});</script></body></html>`;
}

function unauthorizedPage(): string {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>QodeX Control Center — access denied</title></head>'
    + '<body style="background:#0b0f14;color:#e5e7eb;font-family:system-ui,Tahoma,sans-serif;padding:24px;line-height:1.7">'
    + '<h1 style="font-size:20px">🔒 Access denied</h1>'
    + '<p>Open the full private link printed by <code>qodex control</code> (or <code>/control</code>) — it ends with <code>?k=…</code>.</p>'
    + '<p dir="rtl" lang="fa">دسترسی ممنوع است. لینک خصوصی کاملی را که <code>qodex control</code> چاپ کرده باز کنید (با <code>?k=…</code> تمام می‌شود).</p>'
    + '</body></html>';
}

function drainAndIgnore(req: IncomingMessage): void {
  let seen = 0;
  req.on('data', (c: Buffer) => {
    seen += c.length;
    // Don't let a client stream an unbounded body at us after we answered.
    if (seen > MAX_BODY_BYTES * 16) req.destroy();
  });
  req.on('error', () => {});
  req.resume();
}

type BodyResult = { ok: true; value: unknown } | { ok: false };

function collectBody(req: IncomingMessage): Promise<{ ok: true; buf: Buffer } | { ok: false; reason: 'too-large' | 'error' }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (r: { ok: true; buf: Buffer } | { ok: false; reason: 'too-large' | 'error' }) => {
      if (!done) { done = true; resolve(r); }
    };
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { finish({ ok: false, reason: 'too-large' }); return; }
      chunks.push(c);
    });
    req.on('end', () => finish({ ok: true, buf: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, reason: 'error' }));
    req.on('close', () => finish({ ok: false, reason: 'error' }));
  });
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<BodyResult> {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(ct)) {
    drainAndIgnore(req);
    sendError(res, 415, '[UNSUPPORTED_MEDIA_TYPE] Send a JSON body with Content-Type: application/json.', { Connection: 'close' });
    return { ok: false };
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    drainAndIgnore(req);
    sendError(res, 413, `[PAYLOAD_TOO_LARGE] Request bodies are limited to ${MAX_BODY_BYTES} bytes.`, { Connection: 'close' });
    return { ok: false };
  }
  const r = await collectBody(req);
  if (!r.ok) {
    if (r.reason === 'too-large') {
      drainAndIgnore(req);
      sendError(res, 413, `[PAYLOAD_TOO_LARGE] Request bodies are limited to ${MAX_BODY_BYTES} bytes.`, { Connection: 'close' });
    } else if (!res.headersSent) {
      sendError(res, 400, '[BAD_REQUEST] The request body could not be read.');
    }
    return { ok: false };
  }
  const text = r.buf.toString('utf8').trim();
  if (!text) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    sendError(res, 400, '[BAD_JSON] The request body is not valid JSON.');
    return { ok: false };
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

function browserStatus(mgr: BrowserManager | null): BrowserStatus | null {
  if (!mgr) return null;
  try { return mgr.status(); } catch { return null; }
}

function pickLang(rt: Running, req: IncomingMessage): DashboardLang {
  if (rt.lang) return rt.lang;
  const al = String(req.headers['accept-language'] ?? '').trim().toLowerCase();
  return /^fa\b/.test(al) ? 'fa' : 'en';
}

async function defaultSteer(note: string): Promise<boolean> {
  // Lazy: the agent loop is heavy and only present in processes that run an agent.
  const { getActiveAgent } = await import('../agent/loop.js');
  const agent = getActiveAgent();
  if (!agent) return false;
  agent.pushSteer(note);
  return true;
}

const ROUTE_METHODS = new Map<string, 'GET' | 'POST'>([
  ['/', 'GET'],
  ['/index.html', 'GET'],
  ['/api/state', 'GET'],
  ['/api/events', 'GET'],
  ['/api/frames', 'GET'],
  ['/api/frame.jpg', 'GET'],
  ['/api/actions', 'GET'],
  ['/api/input', 'POST'],
  ['/api/takeover', 'POST'],
  ['/api/steer', 'POST'],
]);

async function handleRequest(rt: Running, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  const method = String(req.method ?? 'GET').toUpperCase();
  const { path, query } = splitUrl(rawUrl);
  const isRead = method === 'GET' || method === 'HEAD';

  // 1. Authentication — always, for every route.
  const auth = authenticateRequest(rt.token, rt.port, req);
  if (!auth.ok) {
    if (!isRead) drainAndIgnore(req);
    if (isRead && wantsHtml(req)) sendHtml(res, 401, unauthorizedPage());
    else sendError(res, 401, '[UNAUTHORIZED] Missing or invalid access token. Open the full link printed by `qodex control` (it ends with ?k=…), or send Authorization: Bearer <token>.');
    return;
  }

  // 2. `?k=` login: set the cookie and bounce to the same URL without the token.
  if (auth.via === 'query' && isRead) {
    const target = stripTokenFromUrl(rawUrl);
    const cookie = `${controlCookieName(rt.port)}=${rt.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
    if (wantsHtml(req)) {
      // An HTML bounce (not a 302) so the follow-up navigation is initiated by OUR
      // page — a SameSite=Strict cookie is then sent even when the link was opened
      // from another site (Telegram web, a mail client, ...).
      sendHtml(res, 200, bouncePage(target), { 'Set-Cookie': cookie });
    } else {
      res.writeHead(302, { ...BASE_HEADERS, 'Set-Cookie': cookie, Location: target, 'Content-Length': '0' });
      res.end();
    }
    return;
  }

  // 3. CSRF guard for anything that changes state.
  if (!isRead && !originAllowed(req.headers)) {
    drainAndIgnore(req);
    sendError(res, 403, '[FORBIDDEN_ORIGIN] Cross-origin requests are not allowed.', { Connection: 'close' });
    return;
  }

  // 4. Routes.
  const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
  const actionMatch = path.match(/^\/api\/actions\/([^/]+)$/);
  const expected = ROUTE_METHODS.get(path) ?? (approvalMatch || actionMatch ? 'POST' : undefined);
  if (path === '/favicon.ico') { res.writeHead(204, BASE_HEADERS); res.end(); return; }
  if (!expected) {
    if (!isRead) drainAndIgnore(req);
    sendError(res, 404, `[NOT_FOUND] ${path.slice(0, 200)}`);
    return;
  }
  const methodOk = expected === 'GET' ? isRead : method === expected;
  if (!methodOk) {
    if (!isRead) drainAndIgnore(req);
    sendError(res, 405, `[METHOD_NOT_ALLOWED] Use ${expected}.`, { Allow: expected === 'GET' ? 'GET, HEAD' : expected });
    return;
  }

  if (path === '/' || path === '/index.html') {
    sendHtml(res, 200, renderDashboard({ title: rt.title || undefined, lang: pickLang(rt, req) }));
    return;
  }
  if (path === '/api/state') return routeState(rt, res, query);
  if (path === '/api/events') return routeEvents(rt, req, res);
  if (path === '/api/frames') return routeFrames(rt, req, res);
  if (path === '/api/frame.jpg') return routeFrameJpg(rt, res);
  if (path === '/api/actions') { sendJson(res, 200, { ok: true, actions: listControlActions() }); return; }

  const body = await readJsonBody(req, res);
  if (!body.ok) return;
  if (path === '/api/input') return routeInput(res, body.value);
  if (path === '/api/takeover') return routeTakeover(res, body.value);
  if (path === '/api/steer') return routeSteer(rt, res, body.value);
  if (approvalMatch) return routeApproval(res, approvalMatch[1] ?? '', body.value);
  if (actionMatch) return routeAction(res, actionMatch[1] ?? '', body.value);
  sendError(res, 404, `[NOT_FOUND] ${path.slice(0, 200)}`);
}

async function routeState(rt: Running, res: ServerResponse, query: string): Promise<void> {
  const recentParam = Number(queryParam(query, 'recent') ?? '200');
  const recentN = Number.isFinite(recentParam) ? Math.max(0, Math.min(300, Math.floor(recentParam))) : 200;
  const mgr = peekBrowserManager();
  const state: Record<string, unknown> = {
    ok: true,
    title: rt.title || null,
    browser: browserStatus(mgr),
    approvals: getApprovalBroker().pending().map(publicApproval),
    actions: listControlActions(),
    viewers: rt.eventClients.size + rt.frames.viewers.size,
    ts: Date.now(),
  };
  const missions = actions.get('missions.list');
  if (missions) {
    try {
      state.missions = await withTimeout(Promise.resolve().then(() => missions({ limit: 20 })), 3000, 'missions.list');
    } catch (e) {
      state.missionsError = errMessage(e);
    }
  }
  state.recent = recentN > 0 ? getBus().recent(recentN).map(ev => JSON.parse(busEventJson(ev)) as unknown) : [];
  sendJson(res, 200, state);
}

function streamCount(rt: Running): number {
  return rt.eventClients.size + rt.frames.viewers.size;
}

function routeEvents(rt: Running, req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'HEAD') { sendError(res, 405, '[METHOD_NOT_ALLOWED] Use GET.'); return; }
  if (streamCount(rt) >= MAX_STREAMS) { sendError(res, 503, '[TOO_MANY_STREAMS] Too many open dashboard connections.'); return; }
  openSse(res);
  const client: SseClient = new SseClient(res, () => rt.eventClients.delete(client));
  // Snapshot first (synchronously, so no bus event can slip between history and live).
  client.send('hello', safeStringify({
    title: rt.title || null,
    actions: listControlActions(),
    browser: browserStatus(peekBrowserManager()),
    ts: Date.now(),
  }));
  client.send('approvals', safeStringify(getApprovalBroker().pending().map(publicApproval)));
  for (const ev of getBus().recent(200)) client.send('bus', busEventJson(ev));
  if (!client.closed) rt.eventClients.add(client);
}

function routeFrames(rt: Running, req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'HEAD') { sendError(res, 405, '[METHOD_NOT_ALLOWED] Use GET.'); return; }
  if (streamCount(rt) >= MAX_STREAMS) { sendError(res, 503, '[TOO_MANY_STREAMS] Too many open dashboard connections.'); return; }
  openSse(res);
  rt.frames.add(res);
}

async function routeFrameJpg(rt: Running, res: ServerResponse): Promise<void> {
  const mgr = peekBrowserManager();
  let running = false;
  try { running = !!mgr && mgr.isRunning(); } catch { running = false; }
  if (!mgr || !running) { sendError(res, 404, '[BROWSER_NOT_RUNNING] No browser is running in this QodeX process.'); return; }
  let buf: Buffer;
  const fresh = rt.frames.latest(1500);
  try {
    buf = fresh ? Buffer.from(fresh.data, 'base64') : await withTimeout(mgr.screenshotJpeg(rt.quality), 15_000, 'screenshot');
  } catch (e) {
    sendError(res, 502, `[SCREENSHOT_FAILED] ${errMessage(e)}`);
    return;
  }
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'image/jpeg', 'Content-Length': String(buf.length) });
  res.end(buf);
}

async function routeInput(res: ServerResponse, body: unknown): Promise<void> {
  const v = validateHumanInput(body);
  if (!v.ok) { sendError(res, 400, `[INVALID_INPUT] ${v.error}`); return; }
  const mgr = peekBrowserManager();
  if (!mgr || !mgr.isTakeover()) {
    sendError(res, 409, '[TAKEOVER_REQUIRED] Take over control first (POST /api/takeover {"on":true}); input is ignored while the agent is in control.');
    return;
  }
  // Launching from here is only allowed through an explicit navigation while the human holds control.
  if (v.event.type !== 'navigate' && !mgr.isRunning()) {
    sendError(res, 409, '[BROWSER_NOT_RUNNING] No browser is running yet — enter a URL to open one.');
    return;
  }
  try {
    await withTimeout(mgr.dispatchInput(v.event), 60_000, 'input');
  } catch (e) {
    sendError(res, 502, `[INPUT_FAILED] ${errMessage(e)}`);
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function routeTakeover(res: ServerResponse, body: unknown): Promise<void> {
  const on = asObject(body).on;
  if (typeof on !== 'boolean') { sendError(res, 400, '[INVALID_INPUT] Body must be {"on": true|false}.'); return; }
  let mgr = peekBrowserManager();
  if (!mgr && on) {
    try {
      // Creates the manager object only — this does NOT launch a browser.
      mgr = await getBrowserManager();
    } catch (e) {
      sendError(res, 503, `[BROWSER_UNAVAILABLE] ${errMessage(e)}`);
      return;
    }
  }
  if (mgr) {
    try {
      mgr.setTakeover(on, 'control');
    } catch (e) {
      sendError(res, 500, `[TAKEOVER_FAILED] ${errMessage(e)}`);
      return;
    }
  }
  sendJson(res, 200, { ok: true, takeover: mgr ? mgr.isTakeover() : false, browser: browserStatus(mgr) });
}

async function routeSteer(rt: Running, res: ServerResponse, body: unknown): Promise<void> {
  const raw = asObject(body).note;
  const note = typeof raw === 'string' ? raw.trim() : '';
  if (!note || note.length > 4000) { sendError(res, 400, '[INVALID_INPUT] Body must be {"note": "<1-4000 chars>"}.'); return; }
  let delivered = false;
  try {
    delivered = await (rt.onSteer ?? defaultSteer)(note);
  } catch (e) {
    sendError(res, 500, `[STEER_FAILED] ${errMessage(e)}`);
    return;
  }
  if (!delivered) {
    sendError(res, 409, '[NO_ACTIVE_AGENT] No agent is running in this QodeX process to steer.');
    return;
  }
  getBus().publish({ kind: 'agent', source: 'control', type: 'steer', data: { note: note.length > 500 ? note.slice(0, 500) + '…' : note } });
  sendJson(res, 200, { ok: true });
}

function routeApproval(res: ServerResponse, rawId: string, body: unknown): void {
  const id = safeDecode(rawId);
  if (!id || id.length > 128) { sendError(res, 400, '[INVALID_INPUT] Bad approval id.'); return; }
  const answer = asObject(body).answer;
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 200) {
    sendError(res, 400, '[INVALID_INPUT] Body must be {"answer": "<one of the options>"}.');
    return;
  }
  const broker = getApprovalBroker();
  const pending = broker.get(id);
  if (!pending) { sendError(res, 404, '[APPROVAL_NOT_FOUND] That approval was already answered or does not exist.'); return; }
  if (!broker.resolve(id, answer, 'control')) {
    sendError(res, 400, `[INVALID_ANSWER] Answer with one of: ${pending.options.join(', ')}`);
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function routeAction(res: ServerResponse, rawName: string, body: unknown): Promise<void> {
  const name = safeDecode(rawName);
  const handler = name ? actions.get(name) : undefined;
  if (!name || !handler) {
    sendError(res, 404, `[UNKNOWN_ACTION] Registered actions: ${listControlActions().join(', ') || '(none)'}`);
    return;
  }
  try {
    const result = await handler(body);
    sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
  } catch (e) {
    const msg = errMessage(e);
    sendError(res, 500, msg.startsWith('[') ? msg : `[ACTION_FAILED] ${name}: ${msg}`);
  }
}
