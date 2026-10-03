/**
 * Workflow recorder — learns a replayable workflow from a demonstration.
 *
 * Two event sources feed one recording:
 *
 *   1. AGENT actions: every successful browser_* tool call publishes a
 *      BrowserActionRecord through `BrowserManager.onAction` (with the target's
 *      ElementInfo, password text already replaced by "***").
 *   2. HUMAN actions: for demonstrations the recorder installs an in-page capture
 *      into the browser context (`exposeBinding` + `addInitScript`). It listens to
 *      click / input / change / submit / Enter in every frame, builds a stable
 *      selector (id → data-testid → name → role+name → css path) plus role and
 *      accessible name, and posts them to a binding. Address-bar navigations are
 *      picked up from `framenavigated`. Human input relayed by the control center
 *      also arrives through `onAction` (actor 'human').
 *
 * `stop()` turns the raw event stream into a clean Workflow (pure
 * `buildWorkflowFromRecords`): drops observation noise (snapshots, screenshots,
 * console...), merges keystrokes into one fill, removes focus-clicks before a
 * fill, de-duplicates agent actions that the in-page capture also saw, turns
 * typed values into `{{params}}` (examples kept) and password / one-time-code /
 * card fields into `secret` params whose values are NEVER captured — the page
 * script doesn't even send them to Node.
 *
 * Security: the binding is reachable from page scripts, so every capture call
 * carries a per-recording random nonce held in the capture script's closure (a
 * page can't read it — window property names use a one-way tag, never the
 * nonce), only trusted (user / browser generated) events count, input inside a
 * cross-origin iframe is ignored, and payloads are validated and size-capped in
 * Node. One recording per process.
 */

import { createHash, randomBytes } from 'crypto';
import {
  getBrowserManager,
  type BrowserActionRecord,
  type BrowserManager,
  type ElementInfo,
} from '../tools/browser/types.js';
import { isChallengeElement, isChallengeFrameUrl } from '../tools/browser/challenge.js';
import { getBus } from '../control/bus.js';
import { logger } from '../utils/logger.js';
import {
  describeTarget,
  normalizeWorkflowName,
  toParamName,
  type VaultField,
  type Workflow,
  type WorkflowParam,
  type WorkflowSource,
  type WorkflowStep,
} from './types.js';

// ── raw records ──────────────────────────────────────────────────────────────

export interface RawRecord {
  /** action = BrowserManager.onAction; capture = in-page human capture; nav = address-bar navigation; start = page open when recording began. */
  origin: 'action' | 'capture' | 'nav' | 'start';
  tool: string;
  args: Record<string, unknown>;
  url: string;
  title?: string;
  element?: ElementInfo;
  actor: 'agent' | 'human';
  ts: number;
  /** capture: the event came from a child frame (selector is relative to that frame). */
  frame?: 'main' | 'child';
  /** browser_fill_form: element info per field (resolved from refs while recording). */
  fieldElements?: Array<ElementInfo | null>;
}

type Canon =
  | 'navigate' | 'click' | 'fill' | 'type' | 'fill_form' | 'select' | 'check' | 'press' | 'scroll'
  | 'hover' | 'upload' | 'wait' | 'history' | 'tab' | 'extract' | 'fill_secret' | 'unsupported' | 'noise';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}
function strArr(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(x => typeof x === 'string' || typeof x === 'number').map(String);
  return out.length ? out : undefined;
}

/**
 * Map a tool / human-input name onto a canonical action. Tolerant on purpose:
 * agent tools are `browser_<verb>`, human input from the control center may be
 * recorded as `human_<verb>` or as a generic input record whose `args.type`
 * carries the HumanInputEvent type.
 */
export function canonicalAction(tool: string, args: Record<string, unknown> = {}): { action: Canon; sub?: string } {
  let t = String(tool ?? '').toLowerCase().trim().replace(/^(browser[_.]|human[_.]|qx[_.])/, '');
  if (['input', 'human_input', 'dispatch_input', 'dispatch', 'human', 'event', 'user_input'].includes(t) && typeof args.type === 'string') {
    t = args.type.toLowerCase();
  }
  switch (t) {
    case 'navigate': case 'goto': case 'open': case 'navigation': case 'go': case 'open_url':
      return { action: 'navigate' };
    case 'click': case 'dblclick': case 'double_click': case 'tap': case 'mouse_click':
      return { action: 'click', sub: t };
    case 'fill':
      return { action: 'fill' };
    case 'type': case 'keyboard_type': case 'insert_text': case 'type_text':
      return { action: 'type' };
    case 'fill_form':
      return { action: 'fill_form' };
    case 'select': case 'select_option':
      return { action: 'select' };
    case 'check': case 'uncheck': case 'set_checked':
      return { action: 'check', sub: t };
    case 'press': case 'key': case 'keypress': case 'press_key':
      return { action: 'press' };
    case 'scroll': case 'wheel': case 'mouse_wheel':
      return { action: 'scroll' };
    case 'hover':
      return { action: 'hover' };
    case 'upload': case 'set_input_files': case 'file_upload':
      return { action: 'upload' };
    case 'wait_for': case 'wait':
      return { action: 'wait' };
    case 'history':
      return { action: 'history', sub: str(args.action) ?? 'back' };
    case 'back': case 'go_back':
      return { action: 'history', sub: 'back' };
    case 'forward': case 'go_forward':
      return { action: 'history', sub: 'forward' };
    case 'reload': case 'refresh':
      return { action: 'history', sub: 'reload' };
    case 'tabs': case 'tab':
      return { action: 'tab', sub: str(args.action) ?? 'list' };
    case 'extract': case 'get_text':
      return { action: 'extract' };
    case 'fill_secret':
      return { action: 'fill_secret' };
    case 'drag': case 'drag_and_drop': case 'evaluate':
      return { action: 'unsupported', sub: t };
    default:
      // snapshot, screenshot, console, network, status, downloads, dialog, pdf,
      // close, agent, move, ... — observation or session plumbing, not a step.
      return { action: 'noise', sub: t };
  }
}

// ── proto steps (internal) ───────────────────────────────────────────────────

interface Proto {
  step: WorkflowStep;
  ts: number;
  origin: RawRecord['origin'];
  el?: ElementInfo;
  /** fill/type that appends to the field's current content (human keystrokes). */
  append?: boolean;
  /** secret field: never keep the value. */
  secret?: { field: VaultField | null; vaultEntry?: string };
  /** the target is a text-entry element (a click on it is just focus). */
  textEntry?: boolean;
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
const SECRET_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i;
/** name / id attributes that hold secrets even on type=text inputs. */
const SECRET_ATTR = /(^|[^a-z])(pass(word|wd|code)?|pwd|pin|cvv|cvc|otp|totp|2fa|one-?time)([^a-z]|$)/i;
/** Accessible names (EN + FA) of secret fields: password, PIN, CVV2, one-time / verification code. */
const SECRET_LABEL = /\b(password|passcode|pin|cvv2?|cvc|one[- ]time (code|password)|verification code|2fa code|otp)\b|رمز|کلمه عبور|کلمه‌عبور|گذرواژه|کد تایید|کد تأیید|کد یکبار/i;
const OTP_HINT = /one[- ]time|verification code|2fa|otp|totp|کد تایید|کد تأیید|یکبار/i;

function isTextEntry(el?: ElementInfo): boolean {
  if (!el) return false;
  if (el.isPassword) return true;
  const tag = (el.tag ?? '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') return TEXT_INPUT_TYPES.has((el.inputType ?? '').toLowerCase());
  return ['textbox', 'searchbox'].includes((el.role ?? '').toLowerCase());
}

/** Secret classification for a typed value. null = not secret. */
function secretFieldOf(el: ElementInfo | undefined, value: string | undefined, args: Record<string, unknown>): { field: VaultField | null } | null {
  const ac = (el?.autocomplete ?? '').toLowerCase();
  if (/one-time-code/.test(ac)) return { field: 'totp' };
  if (el?.isPassword || /password/.test(ac)) return { field: 'password' };
  if (SECRET_AUTOCOMPLETE.test(ac)) return { field: null };
  // Text inputs that still hold secrets (PIN, CVV, verification codes) — by attribute
  // or label — plus values the browser layer already redacted.
  const attrs = [el?.selector?.match(/\[name=["']?([^"'\]]+)/)?.[1], el?.selector?.match(/^#([\w-]+)$/)?.[1]].filter(Boolean).join(' ');
  const label = el?.name ?? '';
  const hinted = SECRET_ATTR.test(attrs) || SECRET_LABEL.test(label);
  if (!hinted && value !== '***' && args.redacted !== true && args.secret !== true) return null;
  const hay = `${attrs} ${label}`;
  if (OTP_HINT.test(hay)) return { field: 'totp' };
  if (/(^|[^a-z])(pin|cvv2?|cvc)([^a-z]|$)/i.test(hay)) return { field: null };
  return { field: 'password' };
}

function targetOf(rec: RawRecord, el: ElementInfo | undefined = rec.element, args: Record<string, unknown> = rec.args): Partial<WorkflowStep> {
  const t: Partial<WorkflowStep> = {};
  const selector = (el?.selector || str(args.selector) || '').trim();
  if (selector) t.selector = selector;
  const ref = str(args.ref);
  if (ref && /^(f\d+)?e\d+$/.test(ref)) t.ref = ref;
  if (el?.role) t.role = el.role;
  if (el?.name) t.name = el.name.replace(/\s+/g, ' ').trim().slice(0, 200);
  const text = el?.text?.replace(/\s+/g, ' ').trim();
  if (text && text !== t.name && text.length <= 120) t.text = text;
  if (rec.frame === 'child') t.note = 'inside an iframe — selector is relative to that frame';
  return t;
}

function hasTarget(t: Partial<WorkflowStep>): boolean {
  return !!(t.selector || t.ref || t.name || t.text || t.role);
}

export function targetKey(s: Pick<WorkflowStep, 'selector' | 'role' | 'name' | 'ref' | 'text'>): string {
  if (s.selector) return `s:${s.selector}`;
  if (s.role && s.name) return `r:${s.role}|${s.name}`;
  if (s.ref) return `ref:${s.ref}`;
  if (s.name) return `n:${s.name}`;
  if (s.text) return `t:${s.text}`;
  return '';
}

function isHttpUrl(u: string | undefined): boolean {
  return !!u && /^https?:\/\//i.test(u);
}

function recordToProtos(rec: RawRecord, warnings: string[]): Proto[] {
  const { action, sub } = canonicalAction(rec.tool, rec.args);
  const a = rec.args ?? {};
  const base = { ts: rec.ts, origin: rec.origin, el: rec.element } as const;
  const actor = rec.actor;
  const mk = (step: WorkflowStep, extra: Partial<Proto> = {}): Proto => ({ ...base, step: { ...step, actor }, ...extra });

  switch (action) {
    case 'navigate': {
      const url = str(a.url) || rec.url || '';
      if (!isHttpUrl(url)) {
        if (url && url !== 'about:blank') warnings.push(`skipped navigation to a non-web URL (${url.slice(0, 60)})`);
        return [];
      }
      const step: WorkflowStep = { kind: 'navigate', url };
      if (a.new_tab === true || a.newTab === true) step.newTab = true;
      return [mk(step)];
    }
    case 'click': {
      const t = targetOf(rec);
      if (!hasTarget(t)) {
        warnings.push(`skipped a ${actor} click with no element information${num(a.x) !== undefined ? ` at (${num(a.x)}, ${num(a.y)})` : ''}`);
        return [];
      }
      const step: WorkflowStep = { kind: 'click', ...t };
      const count = num(a.click_count) ?? num(a.clickCount) ?? num(a.count) ?? 1;
      if (a.double === true || sub === 'dblclick' || sub === 'double_click' || count >= 2) step.double = true;
      if (a.button === 'right' || a.button === 'middle') step.button = a.button;
      const mods = (Array.isArray(a.modifiers) ? a.modifiers : []).filter((m): m is 'Alt' | 'Control' | 'Meta' | 'Shift' => ['Alt', 'Control', 'Meta', 'Shift'].includes(m as string));
      if (mods.length) step.modifiers = [...new Set(mods)];
      const desc = str(a.element);
      if (desc && !step.note) step.note = desc.slice(0, 200);
      return [mk(step, { textEntry: isTextEntry(rec.element) })];
    }
    case 'fill': case 'type': {
      const t = targetOf(rec);
      const value = str(a.value) ?? str(a.text) ?? '';
      const secret = secretFieldOf(rec.element, value, a);
      const human = actor === 'human';
      if (!hasTarget(t)) {
        if (action === 'type' || human) {
          // Keystrokes into whatever has focus.
          return [mk({ kind: 'type', value: secret ? '' : value }, { append: true, secret: secret ?? undefined })];
        }
        warnings.push('skipped a fill with no target element');
        return [];
      }
      const slowly = a.slowly === true;
      const step: WorkflowStep = { kind: slowly ? 'type' : 'fill', ...t, value: secret ? '' : value };
      const out: Proto[] = [mk(step, {
        // Relayed human keystrokes append; capture events carry the field's FULL value.
        append: (human && rec.origin === 'action') || a.clear === false,
        secret: secret ?? undefined,
        textEntry: true,
      })];
      if (a.submit === true) out.push(mk({ kind: 'press', key: 'Enter', ...t }));
      return out;
    }
    case 'fill_secret': {
      const t = targetOf(rec);
      const field: VaultField = (['username', 'password', 'totp'] as const).find(f => f === a.field) ?? 'password';
      if (!hasTarget(t)) {
        // browser_fill_secret without ref/selector auto-detected the login field;
        // keep the login step replayable for the fields that can be found generically.
        if (field === 'password') t.selector = 'input[type="password"]';
        else if (field === 'totp') t.selector = 'input[autocomplete="one-time-code"]';
        else { warnings.push('skipped a vault username fill with no target element — add a selector to that step by hand'); return []; }
      }
      return [mk({ kind: 'fill', ...t, value: '' }, { secret: { field, vaultEntry: str(a.secret) }, textEntry: true })];
    }
    case 'fill_form': {
      const fields = Array.isArray(a.fields) ? a.fields : [];
      const out: Proto[] = [];
      fields.forEach((f, i) => {
        if (!isObj(f)) return;
        const el = rec.fieldElements?.[i] ?? undefined;
        const t = targetOf(rec, el ?? undefined, f);
        if (!hasTarget(t)) return;
        const raw = f.value;
        const value = typeof raw === 'boolean' ? String(raw) : (str(raw) ?? '');
        const secret = secretFieldOf(el ?? undefined, value, f);
        out.push({ ts: rec.ts, origin: rec.origin, el: el ?? undefined, step: { kind: 'fill', ...t, value: secret ? '' : value, actor }, secret: secret ?? undefined, textEntry: true });
      });
      if (!out.length && fields.length) warnings.push('skipped a fill_form whose fields could not be resolved');
      return out;
    }
    case 'select': {
      const t = targetOf(rec);
      const values = strArr(a.values) ?? strArr(a.value) ?? strArr(a.option);
      if (!hasTarget(t) || !values) return [];
      const step: WorkflowStep = values.length === 1 ? { kind: 'select', ...t, value: values[0] } : { kind: 'select', ...t, values };
      return [mk(step)];
    }
    case 'check': {
      const t = targetOf(rec);
      if (!hasTarget(t)) return [];
      const checked = a.checked === undefined ? sub !== 'uncheck' : a.checked === true || a.checked === 'true';
      return [mk({ kind: 'fill', ...t, value: checked ? 'true' : 'false' })];
    }
    case 'press': {
      const key = str(a.key)?.trim();
      if (!key) return [];
      const t = targetOf(rec);
      return [mk({ kind: 'press', key, ...t })];
    }
    case 'scroll': {
      const t = targetOf(rec);
      let direction = (['up', 'down', 'left', 'right'] as const).find(d => d === a.direction);
      const dx = num(a.dx) ?? num(a.deltaX) ?? 0;
      const dy = num(a.dy) ?? num(a.deltaY) ?? 0;
      if (!direction) direction = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
      const amount = num(a.amount) ?? (Math.round(Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy)) || undefined);
      const step: WorkflowStep = { kind: 'scroll', direction, ...(amount ? { amount } : {}) };
      // A ref/selector means "scroll this element into view".
      if (str(a.ref) || str(a.selector)) Object.assign(step, t);
      return [mk(step)];
    }
    case 'hover': {
      const t = targetOf(rec);
      return hasTarget(t) ? [mk({ kind: 'hover', ...t })] : [];
    }
    case 'upload': {
      const t = targetOf(rec);
      const files = strArr(a.paths) ?? strArr(a.files);
      if (!files) return [];
      if (actor === 'human') warnings.push('a human file upload was recorded with file names only — pass real paths at replay');
      return [mk({ kind: 'upload', ...t, files })];
    }
    case 'wait': {
      const kind = str(a.kind);
      const value = str(a.value);
      const step: WorkflowStep = { kind: 'wait' };
      if (kind === 'time' || (num(a.time) ?? num(a.ms)) !== undefined) step.waitMs = num(value) ?? num(a.time) ?? num(a.ms) ?? num(a.timeout_ms) ?? 1000;
      else if (kind === 'text' || str(a.text)) step.text = value ?? str(a.text);
      else if (kind === 'selector') step.selector = value;
      else if (kind === 'url') step.url = value;
      else if (kind === 'networkidle' || kind === 'load') { step.waitMs = 1500; step.note = 'network idle'; }
      else {
        if (kind === 'function') warnings.push('skipped a wait_for on a custom JS predicate (not recorded)');
        return [];
      }
      if (step.waitMs === undefined && !step.text && !step.selector && !step.url) return [];
      return [mk(step)];
    }
    case 'history': {
      const v = ['back', 'forward', 'reload'].includes(sub ?? '') ? sub! : 'back';
      return [mk({ kind: 'history', value: v })];
    }
    case 'tab': {
      if (sub === 'new') {
        const url = str(a.url);
        return [mk(url && isHttpUrl(url) ? { kind: 'navigate', url, newTab: true } : { kind: 'tab', value: 'new' })];
      }
      if (sub === 'switch') {
        const index = num(a.index);
        return index === undefined ? [] : [mk({ kind: 'tab', value: 'switch', index })];
      }
      if (sub === 'close') {
        const index = num(a.index);
        return [mk({ kind: 'tab', value: 'close', ...(index !== undefined ? { index } : {}) })];
      }
      return [];
    }
    case 'extract': {
      const t = targetOf(rec);
      const step: WorkflowStep = { kind: 'extract', ...t };
      const format = str(a.format);
      if (format && format !== 'text') step.note = `format: ${format}`;
      return [mk(step)];
    }
    case 'unsupported':
      warnings.push(`${rec.tool} is not recorded (${sub === 'evaluate' ? 'arbitrary JavaScript is never replayed' : 'not replayable from a recording'})`);
      return [];
    default:
      return [];
  }
}

// ── de-duplication ───────────────────────────────────────────────────────────

/** navigate / new tab with a URL — what an agent does to set up a human demonstration. */
function isNavigational(tool: string, args: Record<string, unknown> = {}): boolean {
  const { action, sub } = canonicalAction(tool, isObj(args) ? args : {});
  return action === 'navigate' || (action === 'tab' && sub === 'new');
}

function sameTarget(a: ElementInfo | undefined, b: ElementInfo | undefined, aArgs: Record<string, unknown>, bArgs: Record<string, unknown>): boolean {
  const sa = a?.selector || str(aArgs.selector);
  const sb = b?.selector || str(bArgs.selector);
  if (sa && sb && sa === sb) return true;
  if (a?.name && b?.name && a.name.trim() === b.name.trim() && (!a.role || !b.role || a.role === b.role)) return true;
  return false;
}

const DEDUPE_WINDOW_MS = 15_000;
const NAV_WINDOW_MS = 5_000;

/** What the in-page capture sees when the agent performs `r` through Playwright (its "echo"). */
interface EchoSpec {
  /** Canonical actions of the capture record(s) that mirror it. */
  kinds: Canon[];
  /** press: the key. */
  key?: string;
  /** fill/type: the value the field ends up with (undefined = unknown, e.g. clear:false). */
  value?: string;
  /** The agent's record has no element info (Enter on the focused field): match by key + time. */
  anyTarget?: boolean;
  /**
   * The echo fires DURING the action, so before the agent's record (which is
   * published after the action settled). Only a field's value may be reported
   * later (on blur / change).
   */
  before?: boolean;
}

function echoSpecs(r: RawRecord): EchoSpec[] {
  const a = r.args ?? {};
  switch (canonicalAction(r.tool, a).action) {
    // A click on a checkbox / radio reaches the capture as a change ("check").
    case 'click': case 'check': return [{ kinds: ['click', 'check'], before: true }];
    case 'fill': case 'type': case 'fill_secret': {
      const out: EchoSpec[] = [{ kinds: ['fill', 'type'], value: a.clear === false ? undefined : (str(a.value) ?? str(a.text)) }];
      if (a.submit === true) out.push({ kinds: ['press'], key: 'Enter', before: true });
      return out;
    }
    case 'select': return [{ kinds: ['select'], before: true }];
    case 'press': return [{ kinds: ['press'], key: str(a.key), anyTarget: !r.element?.selector && !r.element?.name && !str(a.selector) && !str(a.ref), before: true }];
    default: return [];
  }
}

function isEcho(c: RawRecord, r: RawRecord, spec: EchoSpec): boolean {
  if (!spec.kinds.includes(canonicalAction(c.tool, c.args).action)) return false;
  if (spec.before && c.ts > r.ts + 50) return false;
  if (spec.key !== undefined && String(c.args.key ?? '').toLowerCase() !== spec.key.toLowerCase()) return false;
  if (spec.value !== undefined && c.tool === 'fill') {
    // The capture reports the field's final value (secrets: only that one was filled).
    const agentSecret = spec.value === '***' || r.element?.isPassword === true;
    const capSecret = c.args.secret === true;
    if (agentSecret || capSecret) { if (!(agentSecret && capSecret)) return false; }
    else if (String(c.args.value ?? '') !== spec.value) return false;
  }
  return spec.anyTarget === true || sameTarget(c.element, r.element, c.args, r.args);
}

/**
 * Pick which raw records count for this source, and drop events that two
 * sources saw twice: an agent click is also seen by the in-page capture (Playwright
 * input is real DOM input), and an address-bar `nav` record is redundant when it
 * is just the result of a click / history action. PURE.
 */
export function selectRecords(records: RawRecord[], source: WorkflowSource): RawRecord[] {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  const hasCapture = sorted.some(r => r.origin === 'capture');
  const kept = sorted.filter(r => {
    if (r.origin === 'start') return true;
    if (r.origin === 'action') {
      if (r.actor === 'agent') return source !== 'human' || isNavigational(r.tool, r.args);
      // Human input relayed by the control center: when the in-page capture is
      // active it already saw the DOM events with better element info, so only
      // keep the navigational ones (URL bar, back/forward/reload, tabs).
      if (source === 'agent') return false;
      const c = canonicalAction(r.tool, r.args).action;
      if (!hasCapture) return true;
      return c === 'navigate' || c === 'history' || c === 'tab' || c === 'scroll';
    }
    // capture / nav
    return source !== 'agent';
  });

  const drop = new Set<RawRecord>();
  // When an agent action really happened: its record is stamped after the action
  // settled; the in-page echo is stamped when the DOM event fired.
  const actedAt = new Map<RawRecord, number>();
  // Mixed: in-page capture events mirroring an agent action.
  if (source === 'mixed') {
    for (const r of kept) {
      if (r.origin !== 'action' || r.actor !== 'agent') continue;
      // One agent action can echo several times (type + submit → fill AND Enter).
      for (const spec of echoSpecs(r)) {
        let best: RawRecord | null = null;
        for (const c of kept) {
          if (c.origin !== 'capture' || drop.has(c)) continue;
          if (Math.abs(c.ts - r.ts) > DEDUPE_WINDOW_MS) continue;
          if (!isEcho(c, r, spec)) continue;
          if (!best || Math.abs(c.ts - r.ts) < Math.abs(best.ts - r.ts)) best = c;
        }
        if (best) {
          drop.add(best);
          actedAt.set(r, Math.min(actedAt.get(r) ?? Infinity, best.ts));
        }
      }
    }
  }
  // Address-bar navigations caused by something else we already recorded.
  for (const n of kept) {
    if (n.origin !== 'nav') continue;
    const redundant = kept.some(r => {
      if (r === n || drop.has(r) || r.origin === 'nav' || r.origin === 'start') return false;
      const c = canonicalAction(r.tool, r.args).action;
      const dt = n.ts - r.ts;
      if ((c === 'navigate' || c === 'history' || c === 'tab') && Math.abs(dt) <= NAV_WINDOW_MS) return true;
      if (!['click', 'press', 'select', 'check', 'fill', 'type', 'fill_form', 'fill_secret'].includes(c)) return false;
      // browser_* tools publish their record AFTER the action settled, so a page load
      // the agent's click / Enter caused is seen BEFORE its record. In-page captures
      // are stamped when the event happens, before the navigation it causes.
      if (r.origin === 'action' && r.actor === 'agent') {
        const at = actedAt.get(r);
        if (at !== undefined) return n.ts >= at && n.ts - at <= NAV_WINDOW_MS && n.ts <= r.ts;
        // No echo pins when it acted (the capture can miss an Enter whose submit unloads
        // the page first): a load just before its record is its doing only if nothing
        // else was recorded in between — a human's Back then typing then the agent's
        // Enter must keep the Back.
        if (!(dt <= 0 && dt >= -NAV_WINDOW_MS)) return false;
        return !kept.some(o => o !== r && o !== n && !drop.has(o) && o.origin !== 'nav' && o.origin !== 'start' && o.ts > n.ts && o.ts < r.ts);
      }
      return dt >= 0 && dt <= NAV_WINDOW_MS;
    });
    if (redundant) drop.add(n);
  }
  return kept.filter(r => !drop.has(r));
}

// ── merge + parameterize ─────────────────────────────────────────────────────

function mergeProtos(protos: Proto[]): Proto[] {
  const out: Proto[] = [];
  for (const p of protos) {
    const prev = out[out.length - 1];
    const s = p.step;
    if (prev) {
      const ps = prev.step;
      const sameKey = targetKey(ps) !== '' && targetKey(ps) === targetKey(s);
      // Keystrokes / repeated fills of one field → one fill.
      if ((s.kind === 'fill' || s.kind === 'type') && (ps.kind === 'fill' || ps.kind === 'type')) {
        if (sameKey || (!targetKey(ps) && !targetKey(s) && ps.kind === 'type' && s.kind === 'type')) {
          ps.value = p.append ? (ps.value ?? '') + (s.value ?? '') : s.value;
          if (s.kind === 'type' && ps.kind === 'fill' && !p.append) ps.kind = 'type';
          prev.secret = prev.secret ?? p.secret;
          if (prev.secret && p.secret?.vaultEntry) prev.secret = p.secret;
          prev.ts = p.ts;
          continue;
        }
      }
      // The first click of a double-click arrives as its own click event.
      if (s.kind === 'click' && s.double && ps.kind === 'click' && !ps.double && sameKey && p.ts - prev.ts < 1000) {
        out[out.length - 1] = p;
        continue;
      }
      // A click that only focused the field we then fill is noise.
      if ((s.kind === 'fill' || s.kind === 'type') && ps.kind === 'click' && sameKey && prev.textEntry && !ps.double) {
        out.pop();
        out.push(p);
        continue;
      }
      if (s.kind === 'scroll' && ps.kind === 'scroll' && ps.direction === s.direction && targetKey(ps) === targetKey(s)) {
        if (ps.amount || s.amount) ps.amount = (ps.amount ?? 600) + (s.amount ?? 600);
        prev.ts = p.ts;
        continue;
      }
      if (s.kind === 'navigate' && ps.kind === 'navigate' && !s.newTab && !ps.newTab) {
        // Same URL twice, or an auto-captured page load immediately superseded.
        if (ps.url === s.url || prev.origin === 'start' || prev.origin === 'nav') {
          out[out.length - 1] = p;
          continue;
        }
      }
      if (s.kind === 'extract' && ps.kind === 'extract' && targetKey(ps) === targetKey(s)) continue;
      if (s.kind === 'tab' && ps.kind === 'tab' && s.value === 'switch' && ps.value === 'switch' && s.index === ps.index) continue;
    }
    out.push(p);
  }
  return out;
}

/** Best param name for a typed value, from the element's metadata. */
function paramBaseName(p: Proto): string {
  const el = p.el;
  const s = p.step;
  const ac = (el?.autocomplete ?? '').toLowerCase().split(/\s+/).pop() ?? '';
  if (ac && !['on', 'off'].includes(ac)) {
    const n = toParamName(ac);
    if (n) return n;
  }
  const label = s.name ?? '';
  const words = label.trim().split(/\s+/).filter(Boolean);
  const fromLabel = toParamName(label);
  if (fromLabel && words.length <= 3) return fromLabel;
  const nameAttr = s.selector?.match(/\[name=["']?([^"'\]]+)["']?\]/)?.[1];
  const fromAttr = toParamName(nameAttr);
  if (fromAttr && fromAttr.length >= 3) return fromAttr;
  const id = s.selector?.match(/^#([A-Za-z][\w-]*)$/)?.[1];
  const fromId = toParamName(id);
  if (fromId) return fromId;
  if (fromLabel) return fromLabel;
  if (fromAttr) return fromAttr;
  const it = toParamName(el?.inputType);
  if (it && it !== 'text') return it;
  return s.kind === 'type' && !targetKey(s) ? 'text' : 'value';
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base || 'value';
  if (!/^[a-z_]/.test(name)) name = `p_${name}`;
  let i = 2;
  let candidate = name;
  while (used.has(candidate)) candidate = `${name}_${i++}`;
  used.add(candidate);
  return candidate;
}

function decodeComponent(s: string, plusIsSpace: boolean): string {
  try {
    return decodeURIComponent(plusIsSpace ? s.replace(/\+/g, ' ') : s);
  } catch {
    return s;
  }
}

/**
 * Put `{{name}}` where `value` is a WHOLE query-parameter value or path segment
 * of `url`. Never inside the origin (typing "shop" on shop.example must not turn
 * the host into a param — replaying with another value would then navigate to a
 * different site) and never inside other words ("news" vs "/newsletter"). PURE.
 */
export function parameterizeUrl(url: string, value: string, name: string): string {
  if (value.trim().length < 3) return url;
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
  if (!m) return url;
  const [, origin, pathPart, query, hash] = m;
  const ph = `{{${name}}}`;
  const pathOut = pathPart!.split('/').map(seg => (seg && decodeComponent(seg, false) === value ? ph : seg)).join('/');
  const queryOut = query
    ? '?' + query.slice(1).split('&').map(kv => {
      const i = kv.indexOf('=');
      return i >= 0 && decodeComponent(kv.slice(i + 1), true) === value ? kv.slice(0, i + 1) + ph : kv;
    }).join('&')
    : '';
  return origin! + pathOut + queryOut + (hash ?? '');
}

function parameterize(protos: Proto[], warnings: string[]): { steps: WorkflowStep[]; params: WorkflowParam[] } {
  const params: WorkflowParam[] = [];
  const used = new Set<string>();
  const reuse = new Map<string, string>(); // targetKey|value → param name
  const steps: WorkflowStep[] = [];

  protos.forEach((p, idx) => {
    const s: WorkflowStep = { ...p.step };
    if ((s.kind === 'fill' || s.kind === 'type') && p.secret) {
      const field = p.secret.field;
      const base = field === 'totp' ? 'otp' : field === 'username' ? 'username' : field === 'password' ? 'password' : (toParamName(s.name) || 'secret');
      const key = `secret|${targetKey(s)}|${p.secret.vaultEntry ?? ''}`;
      let name = reuse.get(key);
      if (!name) {
        name = uniqueName(base, used);
        reuse.set(key, name);
        const param: WorkflowParam = {
          name,
          description: `${field === 'totp' ? 'One-time code' : field === 'username' ? 'Username' : 'Secret'} for ${describeTarget(s)}${p.secret.vaultEntry ? ` (from vault entry "${p.secret.vaultEntry}")` : ''}`,
          secret: field !== 'username',
        };
        if (field) param.vaultField = field;
        if (p.secret.vaultEntry) param.default = `vault:${p.secret.vaultEntry}`;
        params.push(param);
      }
      s.value = `{{${name}}}`;
    } else if ((s.kind === 'fill' || s.kind === 'type') && s.value && !(s.value === 'true' || s.value === 'false')) {
      const value = s.value;
      const key = `${targetKey(s)}|${value}`;
      let name = reuse.get(key);
      if (!name) {
        name = uniqueName(paramBaseName(p), used);
        reuse.set(key, name);
        params.push({ name, description: `Text for ${describeTarget(s)}`, example: value });
        // A later navigation whose URL embeds the typed value (search results page)
        // should follow the param too.
        for (const later of protos.slice(idx + 1)) {
          const url = later.step.kind === 'navigate' ? later.step.url : undefined;
          if (!url) continue;
          const next = parameterizeUrl(url, value, name);
          if (next !== url) later.step = { ...later.step, url: next };
        }
      }
      s.value = `{{${name}}}`;
    } else if (s.kind === 'upload' && s.files?.length) {
      s.files = s.files.map(f => {
        const name = uniqueName('file', used);
        params.push({ name, description: `File to upload to ${describeTarget(s)}`, example: f });
        return `{{${name}}}`;
      });
    }
    steps.push(s);
  });
  if (params.some(p => p.secret)) {
    warnings.push('secret fields were recorded as secret params (values not stored) — at replay pass "vault:<entry>" or let a human type them');
  }
  return { steps, params };
}

export interface BuildMeta {
  name: string;
  description?: string;
  title?: string;
  source: WorkflowSource;
  startUrl?: string;
  createdAt?: string;
}

/**
 * Turn raw recorded events into a Workflow. PURE (no browser, no fs).
 * The result is not validated; `WorkflowStore.save` validates.
 */
export function buildWorkflowFromRecords(records: RawRecord[], meta: BuildMeta): { workflow: Workflow; warnings: string[] } {
  const warnings: string[] = [];
  const selected = selectRecords(records, meta.source);
  const protos: Proto[] = [];
  for (const r of selected) protos.push(...recordToProtos(r, warnings));
  const merged = mergeProtos(protos);
  const { steps, params } = parameterize(merged, warnings);

  let startUrl = isHttpUrl(meta.startUrl) ? meta.startUrl : undefined;
  if (!startUrl) startUrl = steps.find(s => s.kind === 'navigate' && !s.newTab)?.url;
  if (startUrl && steps.length && steps[0]!.kind !== 'navigate') steps.unshift({ kind: 'navigate', url: startUrl });

  const name = normalizeWorkflowName(meta.name);
  const title = meta.title ?? (meta.name.trim() !== name ? meta.name.trim() : undefined);
  const workflow: Workflow = {
    name,
    ...(title ? { title } : {}),
    description: (meta.description ?? '').trim(),
    version: 1,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    source: meta.source,
    ...(startUrl ? { startUrl } : {}),
    params,
    steps,
  };
  return { workflow, warnings: [...new Set(warnings)] };
}

// ── in-page capture ──────────────────────────────────────────────────────────

export const CAPTURE_BINDING = '__qxRecord';

/**
 * Public id for the window properties the capture defines. One-way derived from
 * the nonce: page scripts can list window's own properties, so a property NAME
 * must never contain the nonce itself (it would let any page forge events).
 */
export function captureTag(nonce: string): string {
  return createHash('sha256').update(`qx-capture-tag:${nonce}`).digest('hex').slice(0, 16);
}

/**
 * The capture script injected into every frame for human demonstrations.
 * Plain ES2017 string (tsconfig has no DOM lib). It NEVER sends the value of a
 * password / one-time-code / card field — only the fact that one was filled.
 * The nonce lives only in this closure.
 */
export function captureScript(nonce: string): string {
  const tag = captureTag(nonce);
  return `(() => {
  const NONCE = ${JSON.stringify(nonce)};
  const TAG = ${JSON.stringify(tag)};
  const w = window;
  const mark = '__qxRecInstalled_' + TAG;
  if (w[mark]) return;
  // Grab the binding now, before page scripts run, so a page can't swap it to sniff
  // the nonce. Never pick it up later from the page global: by then a page script
  // could have replaced it with a function that records the nonce.
  const post = typeof w[${JSON.stringify(CAPTURE_BINDING)}] === 'function' ? w[${JSON.stringify(CAPTURE_BINDING)}] : null;
  if (!post) return;
  try { Object.defineProperty(w, mark, { value: true }); } catch (e) { return; }
  const send = (ev) => {
    try {
      post(NONCE, ev);
    } catch (e) {}
  };
  const txt = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const TEXT_TYPES = { '': 1, text: 1, email: 1, password: 1, search: 1, tel: 1, url: 1, number: 1, date: 1, 'datetime-local': 1, month: 1, time: 1, week: 1 };
  const SECRET_AC = /(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i;
  const cssEsc = (s) => { try { if (w.CSS && w.CSS.escape) return w.CSS.escape(s); } catch (e) {} return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c); };
  const attrEsc = (s) => String(s).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } };
  const generated = (id) => /^\\d/.test(id) || /[:]/.test(id) || /\\d{4,}/.test(id) || /^(ember|react-|mui-|radix-|headlessui-|__)/i.test(id) || id.length > 40;
  const tagOf = (el) => (el && el.tagName ? el.tagName.toLowerCase() : '');
  const typeOf = (el) => tagOf(el) === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : '';
  const isTextField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = tagOf(el);
    if (tag === 'textarea') return true;
    if (tag === 'input') return !!TEXT_TYPES[typeOf(el)];
    return !!el.isContentEditable;
  };
  // A field stays secret once seen as one (a "show password" toggle flips type=password to text).
  const secretEls = new WeakSet();
  const SECRET_ATTR = /(^|[^a-z])(pass(word|wd|code)?|pwd|pin|cvv|cvc|otp|totp|2fa|one-?time)([^a-z]|$)/i;
  const isSecret = (el) => {
    if (!el || !el.getAttribute) return false;
    if (secretEls.has(el)) return true;
    const s = typeOf(el) === 'password'
      || SECRET_AC.test(String(el.getAttribute('autocomplete') || ''))
      || SECRET_ATTR.test(String(el.getAttribute('name') || '') + ' ' + String(el.id || ''));
    if (s) secretEls.add(el);
    return s;
  };
  // The real target, also inside open shadow roots (Playwright selectors pierce them).
  const targetOf = (e) => { try { const p = e.composedPath && e.composedPath(); if (p && p[0] && p[0].nodeType === 1) return p[0]; } catch (err) {} return e.target; };
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r.split(/\\s+/)[0];
    const tag = tagOf(el);
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'option') return 'option';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const t = typeOf(el);
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (TEXT_TYPES[t]) return el.hasAttribute('list') ? 'combobox' : 'textbox';
      return '';
    }
    if (el.isContentEditable) return 'textbox';
    return '';
  };
  const accName = (el) => {
    let v = txt(el.getAttribute('aria-label'));
    if (v) return v.slice(0, 120);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      v = txt(lb.split(/\\s+/).map((id) => { const e = document.getElementById(id); return e ? e.textContent : ''; }).join(' '));
      if (v) return v.slice(0, 120);
    }
    if (el.labels && el.labels.length) {
      v = txt(el.labels[0].innerText || el.labels[0].textContent);
      if (v) return v.slice(0, 120);
    }
    const tag = tagOf(el);
    if (tag === 'input') {
      const t = typeOf(el);
      if ((t === 'submit' || t === 'button' || t === 'reset') && txt(el.value)) return txt(el.value).slice(0, 120);
      if (t === 'image' && txt(el.getAttribute('alt'))) return txt(el.getAttribute('alt')).slice(0, 120);
    }
    if (tag === 'img') return txt(el.getAttribute('alt')).slice(0, 120);
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
      v = txt(el.innerText || el.textContent);
      if (v) return v.slice(0, 120);
    }
    v = txt(el.getAttribute('placeholder')) || txt(el.getAttribute('title')) || txt(el.getAttribute('alt'));
    return v.slice(0, 120);
  };
  const cssPath = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 8) {
      if (cur.id && !generated(cur.id) && unique('#' + cssEsc(cur.id))) { parts.unshift('#' + cssEsc(cur.id)); break; }
      const tag = tagOf(cur);
      let seg = tag;
      const p = cur.parentElement;
      if (p) {
        const same = Array.prototype.filter.call(p.children, (c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = p;
    }
    return parts.join(' > ');
  };
  const buildSelector = (el, role, name) => {
    const tag = tagOf(el);
    if (el.id && !generated(el.id)) { const s = '#' + cssEsc(el.id); if (unique(s)) return s; }
    const attrs = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
    for (let i = 0; i < attrs.length; i++) {
      const v = el.getAttribute(attrs[i]);
      if (v) { const s = '[' + attrs[i] + '="' + attrEsc(v) + '"]'; if (unique(s)) return s; }
    }
    const nm = el.getAttribute('name');
    if (nm && /^(input|select|textarea|button)$/.test(tag)) {
      let s = tag + '[name="' + attrEsc(nm) + '"]';
      if (typeOf(el) === 'radio' || typeOf(el) === 'checkbox') s += '[value="' + attrEsc(el.value) + '"]';
      if (unique(s)) return s;
      const form = el.form;
      if (form) {
        let fs = '';
        if (form.id && !generated(form.id) && unique('#' + cssEsc(form.id))) fs = '#' + cssEsc(form.id);
        else if (form.getAttribute('name') && unique('form[name="' + attrEsc(form.getAttribute('name')) + '"]')) fs = 'form[name="' + attrEsc(form.getAttribute('name')) + '"]';
        if (fs && unique(fs + ' ' + s)) return fs + ' ' + s;
      }
    }
    if (role && name && name.length <= 80) return 'role=' + role + '[name="' + attrEsc(name) + '"s]';
    return cssPath(el);
  };
  const describe = (el) => {
    const role = roleOf(el);
    const name = accName(el);
    const info = { selector: buildSelector(el, role, name), role: role, name: name, tag: tagOf(el) };
    const t = typeOf(el);
    if (t) info.inputType = t;
    const ac = el.getAttribute('autocomplete');
    if (ac) info.autocomplete = String(ac).slice(0, 60);
    if (t === 'password') info.isPassword = true;
    if (tagOf(el) === 'a' && el.href) info.href = String(el.href).slice(0, 500);
    const tx = txt(el.innerText || el.textContent);
    if (tx && tx !== name) info.text = tx.slice(0, 120);
    if (el.form && el.form.action) info.formAction = String(el.form.action).slice(0, 500);
    return info;
  };
  const valueOf = (el) => el.isContentEditable && tagOf(el) !== 'input' && tagOf(el) !== 'textarea' ? String(el.innerText || '') : String(el.value == null ? '' : el.value);
  const base = () => ({ url: String(location.href).slice(0, 2000), title: String(document.title || '').slice(0, 200) });
  const pending = [];
  // Last value reported per field (kept in this closure only): Enter fires keydown
  // AND change, focusout follows — the same value must not become a second step.
  const lastSent = new WeakMap();
  const flushOne = (el) => {
    const i = pending.indexOf(el);
    if (i < 0) return;
    pending.splice(i, 1);
    const v = valueOf(el);
    if (lastSent.get(el) === v) return;
    lastSent.set(el, v);
    const secret = isSecret(el);
    const ev = base();
    ev.type = 'fill';
    ev.el = describe(el);
    ev.secret = secret;
    ev.value = secret ? '' : v.slice(0, 5000);
    send(ev);
  };
  // Enter in a text field submits its form through a synthetic click on the
  // default button; that click is part of the recorded "press Enter".
  let lastEnter = null;
  const flushAll = () => { const els = pending.slice(); for (let i = 0; i < els.length; i++) flushOne(els[i]); };
  try { Object.defineProperty(w, '__qxRecFlush_' + TAG, { value: flushAll }); } catch (e) {}
  // Nearest genuinely interactive ancestor (not any focusable wrapper / container).
  const CLICKABLE = 'a,button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=option],[role=treeitem],[onclick]';
  // Only trusted (user / browser-generated) input counts: a page script that sets a
  // value and dispatches a synthetic input/change event must not author steps.
  document.addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    const el = targetOf(e);
    if (isTextField(el)) {
      isSecret(el);
      if (pending.indexOf(el) < 0) pending.push(el);
    }
  }, true);
  document.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const el = targetOf(e);
    if (!el || el.nodeType !== 1) return;
    const tag = tagOf(el);
    const t = typeOf(el);
    if (tag === 'select') {
      flushAll();
      const ev = base(); ev.type = 'select'; ev.el = describe(el);
      ev.values = Array.prototype.filter.call(el.options, (o) => o.selected).map((o) => String(o.value));
      send(ev);
    } else if (t === 'checkbox' || t === 'radio') {
      flushAll();
      const ev = base(); ev.type = 'check'; ev.el = describe(el); ev.checked = !!el.checked;
      send(ev);
    } else if (t === 'file') {
      flushAll();
      const ev = base(); ev.type = 'upload'; ev.el = describe(el);
      ev.files = Array.prototype.map.call(el.files || [], (f) => String(f.name));
      send(ev);
    } else if (isTextField(el)) {
      if (pending.indexOf(el) < 0) pending.push(el);
      flushOne(el);
    }
  }, true);
  document.addEventListener('focusout', (e) => { const el = targetOf(e); if (pending.indexOf(el) >= 0) flushOne(el); }, true);
  document.addEventListener('submit', () => flushAll(), true);
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter' || e.isComposing) return;
    const el = targetOf(e);
    if (!el || el.nodeType !== 1 || tagOf(el) === 'textarea' || el.isContentEditable) return;
    if (!(tagOf(el) === 'input' && TEXT_TYPES[typeOf(el)])) return;
    if (pending.indexOf(el) < 0) pending.push(el);
    flushOne(el);
    lastEnter = { form: el.form || null, t: Date.now() };
    const ev = base(); ev.type = 'press'; ev.key = 'Enter'; ev.el = describe(el);
    send(ev);
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const t0 = targetOf(e);
    if (!t0 || t0.nodeType !== 1) return;
    const el = (t0.closest && t0.closest(CLICKABLE)) || t0;
    // Implicit submission: detail 0 (no pointer), on the form the Enter was pressed in.
    if (e.detail === 0 && lastEnter && lastEnter.form && el.form === lastEnter.form && Date.now() - lastEnter.t < 1000) { lastEnter = null; return; }
    flushAll();
    const tag = tagOf(el);
    const t = typeOf(el);
    // Focus clicks on fields and clicks that toggle a checkbox/radio/file input are covered by input/change.
    if (tag === 'input' && (TEXT_TYPES[t] || t === 'checkbox' || t === 'radio' || t === 'file')) return;
    if (tag === 'textarea' || tag === 'select' || tag === 'option' || el.isContentEditable) return;
    if (tag === 'label') {
      const c = el.control;
      if (c && /^(input|textarea|select)$/i.test(c.tagName)) return;
    }
    const ev = base(); ev.type = 'click'; ev.el = describe(el); ev.button = e.button; ev.count = e.detail;
    send(ev);
  }, true);
  w.addEventListener('pagehide', () => flushAll(), true);
})();`;
}

function sanitizeElement(v: unknown): ElementInfo | undefined {
  if (!isObj(v)) return undefined;
  const out: ElementInfo = {};
  const keys = ['selector', 'role', 'name', 'tag', 'inputType', 'autocomplete', 'href', 'text', 'formAction'] as const;
  for (const k of keys) {
    const s = v[k];
    if (typeof s === 'string' && s) out[k] = s.slice(0, k === 'selector' ? 1000 : 500);
  }
  if (v.isPassword === true) out.isPassword = true;
  return out;
}

/** Convert one validated capture payload into a raw record (exported for tests). */
export function captureToRecord(payload: unknown, info: { frame?: 'main' | 'child'; ts?: number } = {}): RawRecord | null {
  if (!isObj(payload)) return null;
  const type = payload.type;
  const element = sanitizeElement(payload.el);
  const url = typeof payload.url === 'string' ? payload.url.slice(0, 2000) : '';
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 200) : undefined;
  const base = { origin: 'capture' as const, url, title, element, actor: 'human' as const, ts: info.ts ?? Date.now(), frame: info.frame };
  switch (type) {
    case 'click':
      if (!element) return null;
      return { ...base, tool: 'click', args: { button: payload.button === 2 ? 'right' : payload.button === 1 ? 'middle' : 'left', click_count: num(payload.count) ?? 1 } };
    case 'fill': {
      if (!element) return null;
      // A secret field's value never leaves the page; mark the record so it becomes a secret param.
      const secret = payload.secret === true;
      return { ...base, tool: 'fill', args: { value: secret ? '' : String(payload.value ?? '').slice(0, 5000), ...(secret ? { secret: true } : {}) } };
    }
    case 'select': {
      if (!element) return null;
      const values = strArr(payload.values)?.map(v => v.slice(0, 500));
      return values ? { ...base, tool: 'select', args: { values } } : null;
    }
    case 'check':
      if (!element) return null;
      return { ...base, tool: 'check', args: { checked: payload.checked === true } };
    case 'press': {
      const key = typeof payload.key === 'string' ? payload.key.slice(0, 40) : '';
      return key ? { ...base, tool: 'press', args: { key } } : null;
    }
    case 'upload': {
      const files = strArr(payload.files)?.map(f => f.slice(0, 300));
      return element && files ? { ...base, tool: 'upload', args: { files } } : null;
    }
    default:
      return null;
  }
}

// ── recorder ─────────────────────────────────────────────────────────────────

export interface StartRecordingOptions {
  name: string;
  description?: string;
  /** agent = the agent's own browser_* calls; human = a person demonstrating; mixed = both. */
  source?: WorkflowSource;
  /** Display title (defaults to the given name when it had to be normalized). */
  title?: string;
  /** Inject a manager (tests); defaults to the process-wide QodeX browser. */
  mgr?: BrowserManager;
  /** Saving on stop may replace an existing workflow of the same name (carried for the caller). */
  overwrite?: boolean;
}

export interface RecordingStatus {
  active: boolean;
  name?: string;
  title?: string;
  source?: WorkflowSource;
  startedAt?: number;
  events: number;
  /** Steps the recording would produce if stopped now. */
  steps: number;
  preview: string[];
  /** In-page human capture is installed in the browser. */
  capturing: boolean;
  warnings: string[];
}

/** Routes binding calls to the recorder that owns the nonce (bindings outlive recorders on old Playwright). */
const captureRoutes = new Map<string, (source: any, payload: unknown) => void>();
const boundContexts = new WeakSet<object>();
let activeRecorder: WorkflowRecorder | null = null;
const MAX_RECORDS = 10_000;
const TOO_MANY = `recording reached ${MAX_RECORDS} raw events — later events were dropped; stop and split the task into smaller workflows`;
const CROSS_ORIGIN_FRAME = 'ignored input inside a cross-origin frame (embedded widget / ad) — it cannot be replayed; do that part by hand';
const CHALLENGE_SKIPPED = 'skipped steps on a CAPTCHA / bot check — those are never recorded or replayed; a human passes them at replay time';

/** Same web origin? about:blank / about:srcdoc frames inherit their parent's origin. */
function sameOrigin(frameUrl: string, mainUrl: string): boolean {
  if (/^about:/i.test(frameUrl)) return true;
  try {
    const a = new URL(frameUrl).origin;
    const b = new URL(mainUrl).origin;
    return a !== 'null' && a === b;
  } catch {
    return false;
  }
}

function captureBinding(source: any, nonce: unknown, payload: unknown): void {
  if (typeof nonce !== 'string') return;
  const route = captureRoutes.get(nonce);
  if (route) {
    try { route(source, payload); } catch (e: any) { logger.debug('workflow capture handler failed', { err: e?.message }); }
  }
}

function runDisposers(list: Array<() => unknown>): void {
  for (const d of list.splice(0)) {
    try {
      const r = d();
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => {});
    } catch { /* ignore */ }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

export class WorkflowRecorder {
  private state: 'idle' | 'recording' | 'stopped' = 'idle';
  private opts: Required<Pick<StartRecordingOptions, 'name' | 'source'>> & StartRecordingOptions = { name: '', source: 'agent' };
  private mgr: BrowserManager | null = null;
  private records: RawRecord[] = [];
  private pending = new Set<Promise<unknown>>();
  private unsubs: Array<() => void> = [];
  private nonce = '';
  private startedAt = 0;
  private captureCtx: any = null;
  private installing: Promise<boolean> | null = null;
  /** Bumped by every start(): a slow capture install from an earlier recording must not attach to this one. */
  private generation = 0;
  private disposers: Array<() => unknown> = [];
  private lastUrlByPage = new WeakMap<object, string>();
  private lastCapturePage: object | null = null;
  private startUrl?: string;
  /** Warnings from the last stop() (and capture problems while recording). */
  warnings: string[] = [];

  isRecording(): boolean {
    return this.state === 'recording';
  }

  /** Options the current / last recording was started with. */
  options(): Readonly<StartRecordingOptions> {
    return { ...this.opts };
  }

  async start(opts: StartRecordingOptions): Promise<RecordingStatus> {
    if (this.state === 'recording') throw new Error(`[RECORDING_ACTIVE] already recording "${this.opts.name}" — stop or discard it first`);
    if (activeRecorder && activeRecorder !== this && activeRecorder.isRecording()) {
      throw new Error(`[RECORDING_ACTIVE] a workflow recording ("${activeRecorder.opts.name}") is already running in this process — stop or discard it first`);
    }
    const name = normalizeWorkflowName(opts.name);
    if (!name) throw new Error('[WORKFLOW_NAME] a workflow name is required');
    const source: WorkflowSource = opts.source === 'human' || opts.source === 'mixed' ? opts.source : 'agent';
    // Claim the process-wide slot synchronously so two concurrent starts can't both win.
    this.state = 'recording';
    activeRecorder = this;
    this.generation++;
    this.installing = null;
    this.opts = { ...opts, name: opts.name, source };
    this.records = [];
    this.pending = new Set();
    this.warnings = [];
    this.nonce = randomBytes(16).toString('hex');
    this.startedAt = Date.now();
    this.captureCtx = null;
    this.lastCapturePage = null;
    this.startUrl = undefined;
    let mgr = opts.mgr ?? null;
    if (!mgr) {
      try {
        mgr = await getBrowserManager();
      } catch (e: any) {
        this.state = 'idle';
        if (activeRecorder === this) activeRecorder = null;
        throw new Error(`[BROWSER_UNAVAILABLE] ${e?.message ?? e}`);
      }
    }
    this.mgr = mgr;

    this.unsubs.push(mgr.onAction(rec => this.onAction(rec)));
    if (source !== 'agent') {
      captureRoutes.set(this.nonce, (src, payload) => this.onCapture(src, payload));
      // (Re)install the in-page capture whenever the browser (re)launches or opens tabs.
      this.unsubs.push(getBus().subscribe(ev => {
        if (ev.kind !== 'browser' || this.state !== 'recording') return;
        if (ev.type === 'closed') { this.captureCtx = null; return; }
        if (ev.type === 'launched' || ev.type === 'tab' || ev.type === 'navigated') void this.ensureCapture();
      }));
    }

    if (mgr.isRunning()) {
      const url = mgr.activeUrl();
      if (isHttpUrl(url)) {
        this.startUrl = url;
        this.records.push({ origin: 'start', tool: 'navigate', args: { url }, url, actor: source === 'human' ? 'human' : 'agent', ts: this.startedAt - 1 });
      }
      if (source !== 'agent') await this.ensureCapture();
    }
    return this.status();
  }

  status(): RecordingStatus {
    if (this.state !== 'recording') return { active: false, events: 0, steps: 0, preview: [], capturing: false, warnings: [...this.warnings] };
    const { workflow, warnings } = this.build();
    return {
      active: true,
      name: workflow.name,
      ...(workflow.title ? { title: workflow.title } : {}),
      source: this.opts.source,
      startedAt: this.startedAt,
      events: this.records.length,
      steps: workflow.steps.length,
      preview: workflow.steps.slice(-8).map(s => s.kind + ': ' + describeTargetSafe(s)),
      capturing: !!this.captureCtx,
      warnings: [...new Set([...this.warnings, ...warnings])],
    };
  }

  /** Feed a raw record directly (used by tests and by integrations with their own event source). */
  ingest(rec: RawRecord): void {
    if (this.state !== 'recording') return;
    this.push(rec);
  }

  /** Append a raw record, bounded so a runaway event source can't exhaust memory. */
  private push(rec: RawRecord): void {
    if (this.records.length >= MAX_RECORDS) {
      if (!this.warnings.includes(TOO_MANY)) this.warnings.push(TOO_MANY);
      return;
    }
    this.records.push(rec);
  }

  /** Stop recording and return the learned workflow (not saved — see tools/command). */
  async stop(): Promise<Workflow> {
    if (this.state !== 'recording') throw new Error('[NOT_RECORDING] no workflow recording is active');
    await this.flushCapture();
    await Promise.allSettled([...this.pending]);
    this.teardown();
    const { workflow, warnings } = this.build();
    this.warnings = [...new Set([...this.warnings, ...warnings])];
    return workflow;
  }

  /** Stop without producing a workflow. */
  async discard(): Promise<void> {
    if (this.state !== 'recording') return;
    this.teardown();
    this.records = [];
  }

  // ── internals ──

  private build(): { workflow: Workflow; warnings: string[] } {
    return buildWorkflowFromRecords(this.records, {
      name: this.opts.name,
      description: this.opts.description,
      title: this.opts.title,
      source: this.opts.source,
      startUrl: this.startUrl,
      createdAt: new Date(this.startedAt).toISOString(),
    });
  }

  private teardown(): void {
    this.state = 'stopped';
    for (const u of this.unsubs.splice(0)) { try { u(); } catch { /* ignore */ } }
    captureRoutes.delete(this.nonce);
    runDisposers(this.disposers.splice(0));
    this.captureCtx = null;
    if (activeRecorder === this) activeRecorder = null;
  }

  private track<T>(p: Promise<T>): void {
    const q = p.catch(() => undefined).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  /**
   * Steps on a CAPTCHA / bot check are never recorded: a replay would click the widget
   * automatically. That covers anything inside a challenge frame or widget, and every
   * human step while a hand-off (browser_request_human) owns the browser.
   */
  private skipChallenge(element: ElementInfo | undefined, actor: 'agent' | 'human', frameUrl?: string): boolean {
    let handoff = false;
    if (actor === 'human') {
      try { handoff = /^handoff:/.test(String(this.mgr?.status().takeoverBy ?? '')); } catch { handoff = false; }
    }
    const hit = handoff || isChallengeElement(element) || (!!frameUrl && isChallengeFrameUrl(frameUrl));
    if (hit && !this.warnings.includes(CHALLENGE_SKIPPED)) this.warnings.push(CHALLENGE_SKIPPED);
    return hit;
  }

  private onAction(rec: BrowserActionRecord): void {
    if (this.state !== 'recording' || !rec || typeof rec.tool !== 'string') return;
    const actor = rec.actor === 'human' ? 'human' : 'agent';
    if (this.skipChallenge(rec.element, actor)) return;
    if (this.opts.source === 'agent' && actor !== 'agent') return;
    // A human demonstration keeps the agent's navigations: they set up where the demo starts.
    if (this.opts.source === 'human' && actor !== 'human' && !isNavigational(rec.tool, rec.args)) return;
    const raw: RawRecord = {
      origin: 'action',
      tool: rec.tool,
      args: isObj(rec.args) ? { ...rec.args } : {},
      url: typeof rec.url === 'string' ? rec.url : '',
      ...(rec.title ? { title: rec.title } : {}),
      ...(rec.element ? { element: { ...rec.element } } : {}),
      actor,
      ts: typeof rec.ts === 'number' ? rec.ts : Date.now(),
    };
    this.push(raw);
    this.enrich(raw);
    if (this.opts.source !== 'agent' && !this.captureCtx) void this.ensureCapture();
  }

  /** Resolve snapshot refs to element info while the element (probably) still exists. */
  private enrich(raw: RawRecord): void {
    const mgr = this.mgr;
    if (!mgr) return;
    const { action } = canonicalAction(raw.tool, raw.args);
    if (action === 'fill_form' && Array.isArray(raw.args.fields)) {
      const fields = raw.args.fields as unknown[];
      raw.fieldElements = fields.map(() => null);
      fields.forEach((f, i) => {
        const ref = isObj(f) ? str(f.ref) : undefined;
        if (!ref) return;
        this.track(withTimeout(mgr.describeRef(ref), 1500).then(info => { if (info) raw.fieldElements![i] = info; }));
      });
      return;
    }
    const needs = ['click', 'fill', 'type', 'select', 'check', 'press', 'hover', 'upload', 'fill_secret', 'extract'].includes(action);
    const ref = str(raw.args.ref);
    if (!needs || !ref || raw.element?.selector) return;
    this.track(withTimeout(mgr.describeRef(ref), 1500).then(info => {
      if (info) raw.element = { ...info, ...(raw.element ?? {}), selector: raw.element?.selector || info.selector };
    }));
  }

  private async ensureCapture(): Promise<boolean> {
    if (this.state !== 'recording' || this.opts.source === 'agent' || !this.mgr) return false;
    if (this.installing) return this.installing;
    let ctx: any = null;
    try { ctx = this.mgr.isRunning() ? this.mgr.context() : null; } catch { ctx = null; }
    if (!ctx) return false;
    if (ctx === this.captureCtx) return true;
    const p: Promise<boolean> = this.installCapture(ctx).finally(() => { if (this.installing === p) this.installing = null; });
    this.installing = p;
    return p;
  }

  /**
   * Install the in-page capture on `ctx`. Everything it registers (binding, init
   * script, listeners) goes into a local list that is handed to the recording
   * only if that SAME recording is still running when the install finishes —
   * otherwise (stopped / discarded / a new recording started meanwhile) it is
   * disposed right away, so a slow install can't leave a capture script injected
   * into every page of the context for the rest of the browser's life.
   */
  private async installCapture(ctx: any): Promise<boolean> {
    const gen = this.generation;
    const own: Array<() => unknown> = [];
    const stillMine = () => this.state === 'recording' && this.generation === gen;
    const finish = (ok: boolean): boolean => {
      if (ok && stillMine()) {
        this.disposers.push(...own);
        this.captureCtx = ctx;
        return true;
      }
      runDisposers(own);
      return false;
    };
    const script = captureScript(this.nonce);
    try {
      if (!boundContexts.has(ctx)) {
        const disp = await ctx.exposeBinding(CAPTURE_BINDING, captureBinding);
        boundContexts.add(ctx);
        if (disp && typeof disp.dispose === 'function') {
          own.push(() => { boundContexts.delete(ctx); return disp.dispose(); });
        }
      }
    } catch (e: any) {
      // Another owner registered it (an older Playwright without dispose): our router still works.
      if (!/already registered/i.test(String(e?.message ?? e))) {
        if (stillMine()) this.warnings.push(`human capture unavailable: ${String(e?.message ?? e).split('\n')[0]}`);
        return finish(false);
      }
      boundContexts.add(ctx);
    }
    try {
      const disp = await ctx.addInitScript({ content: script });
      if (disp && typeof disp.dispose === 'function') own.push(() => disp.dispose());
    } catch (e: any) {
      if (stillMine()) this.warnings.push(`human capture init script failed: ${String(e?.message ?? e).split('\n')[0]}`);
    }
    if (!stillMine()) return finish(false);
    // New pages get the capture from the init script; we only need their navigations.
    const onPage = (page: any) => { if (stillMine()) this.watchPage(page, this.disposers); };
    try {
      ctx.on('page', onPage);
      own.push(() => { try { ctx.off?.('page', onPage); } catch { /* ignore */ } });
    } catch { /* ignore */ }
    let pages: any[] = [];
    try { pages = ctx.pages(); } catch { pages = []; }
    for (const page of pages) {
      this.watchPage(page, own);
      let frames: any[] = [];
      try { frames = page.frames(); } catch { frames = []; }
      await Promise.all(frames.map(f => withTimeout(Promise.resolve(f.evaluate(script)), 2000)));
      try {
        const u = page.url();
        if (typeof u === 'string') this.lastUrlByPage.set(page, u);
      } catch { /* ignore */ }
    }
    return finish(true);
  }

  private watchPage(page: any, sink: Array<() => unknown>): void {
    const onNav = (frame: any) => {
      try {
        if (frame !== page.mainFrame()) return;
        this.onNav(page, String(frame.url()));
      } catch { /* ignore */ }
    };
    try {
      page.on('framenavigated', onNav);
      sink.push(() => { try { page.off?.('framenavigated', onNav); } catch { /* ignore */ } });
    } catch { /* ignore */ }
  }

  private onNav(page: object, url: string): void {
    if (this.state !== 'recording' || !isHttpUrl(url)) return;
    if (this.lastUrlByPage.get(page) === url) return;
    this.lastUrlByPage.set(page, url);
    this.push({ origin: 'nav', tool: 'navigate', args: { url }, url, actor: 'human', ts: Date.now() });
  }

  private onCapture(source: any, payload: unknown): void {
    if (this.state !== 'recording') return;
    let frame: 'main' | 'child' = 'main';
    const page = source?.page ?? null;
    let crossOrigin = false;
    try {
      const main = page?.mainFrame?.() ?? null;
      if (page && source?.frame && source.frame !== main) {
        frame = 'child';
        crossOrigin = !sameOrigin(String(source.frame.url?.() ?? ''), String(main?.url?.() ?? page.url?.() ?? ''));
      }
    } catch {
      crossOrigin = frame === 'child';
    }
    let frameUrl = '';
    try { frameUrl = String(source?.frame?.url?.() ?? ''); } catch { frameUrl = ''; }
    if (this.skipChallenge(undefined, 'human', frameUrl)) return;
    if (crossOrigin) {
      // An embedded third-party frame (ad, widget, tracker) can post forged events
      // whose selectors would replay against the MAIN page; and real input there
      // can't be replayed (replay doesn't enter frames). Never record it.
      if (!this.warnings.includes(CROSS_ORIGIN_FRAME)) this.warnings.push(CROSS_ORIGIN_FRAME);
      return;
    }
    const rec = captureToRecord(payload, { frame });
    if (!rec) return;
    if (this.skipChallenge(rec.element, 'human')) return;
    if (page && this.lastCapturePage && page !== this.lastCapturePage) {
      // The human moved to another tab (popup or manual switch).
      let index = -1;
      try { index = (this.captureCtx?.pages?.() ?? []).indexOf(page); } catch { index = -1; }
      if (index >= 0) this.push({ origin: 'capture', tool: 'tab', args: { action: 'switch', index }, url: rec.url, actor: 'human', ts: rec.ts - 1 });
    }
    if (page) this.lastCapturePage = page;
    this.push(rec);
  }

  private async flushCapture(): Promise<void> {
    const ctx = this.captureCtx;
    if (!ctx) return;
    let pages: any[] = [];
    try { pages = ctx.pages(); } catch { pages = []; }
    const expr = `(() => { const f = window[${JSON.stringify('__qxRecFlush_' + captureTag(this.nonce))}]; if (typeof f === 'function') f(); return true; })()`;
    const calls: Array<Promise<unknown>> = [];
    for (const page of pages) {
      let frames: any[] = [];
      try { frames = page.frames(); } catch { frames = []; }
      for (const f of frames) calls.push(withTimeout(Promise.resolve(f.evaluate(expr)), 1500));
    }
    await Promise.all(calls);
    // Binding calls made during the flush are dispatched before the evaluate replies; give them a tick.
    await new Promise(r => setTimeout(r, 50));
  }
}

function describeTargetSafe(s: WorkflowStep): string {
  if (s.kind === 'navigate') return s.url ?? '';
  if (s.kind === 'press') return s.key ?? '';
  return describeTarget(s);
}

/** The process-wide recorder (one active recording per process). */
let shared: WorkflowRecorder | null = null;
export function getWorkflowRecorder(): WorkflowRecorder {
  if (activeRecorder) return activeRecorder;
  if (!shared) shared = new WorkflowRecorder();
  return shared;
}

/** The recorder currently recording, if any. */
export function getActiveRecording(): WorkflowRecorder | null {
  return activeRecorder && activeRecorder.isRecording() ? activeRecorder : null;
}
