/**
 * Workflow model — a recorded browser procedure QodeX can replay.
 *
 * A workflow is learned either from the agent's own browser_* tool calls, from a
 * human demonstrating the task in the QodeX browser (headed window or the control
 * center's takeover), or both. It is stored as plain JSON under
 * ~/.qodex/workflows/<name>.json so users can read, diff and hand-edit it.
 *
 * Steps keep BOTH a replay selector and the target's ARIA role + accessible name,
 * so replay can self-heal when the page's markup drifts (selector → role/name →
 * text → label). Values the user typed become `{{param}}` placeholders; password
 * fields become `secret` params that are never written to disk.
 *
 * This file is PURE: types, name normalization, placeholder helpers and a
 * human-readable step describer shared by the store, recorder, replay, skill
 * generator and tools.
 */

import { createHash } from 'crypto';

export type WorkflowSource = 'agent' | 'human' | 'mixed';

export type WorkflowStepKind =
  | 'navigate'
  | 'click'
  | 'type'
  | 'fill'
  | 'select'
  | 'press'
  | 'scroll'
  | 'wait'
  | 'upload'
  | 'extract'
  | 'hover'
  | 'history'
  | 'tab';

export const STEP_KINDS: readonly WorkflowStepKind[] = [
  'navigate', 'click', 'type', 'fill', 'select', 'press', 'scroll', 'wait', 'upload', 'extract',
  'hover', 'history', 'tab',
];

/** Vault field a secret param maps to (filled through browser_fill_secret). */
export type VaultField = 'username' | 'password' | 'totp';

export interface WorkflowParam {
  /** Placeholder name used as `{{name}}` in steps. `[a-z_][a-z0-9_]*`. */
  name: string;
  description?: string;
  /** Value seen while recording (never stored for secret params). */
  example?: string;
  /** Password / one-time code: never persisted, masked in every report. */
  secret?: boolean;
  /** Used when the caller doesn't pass the param (e.g. "vault:github"). */
  default?: string;
  /** For secret params: which vault field a "vault:<entry>" value fills. */
  vaultField?: VaultField;
}

export interface WorkflowStep {
  kind: WorkflowStepKind;
  /** navigate: target URL. wait: URL substring / glob to wait for. */
  url?: string;
  /** Replay selector (Playwright syntax: css, #id, [data-testid=..], role=..., internal:...). */
  selector?: string;
  /** Snapshot ref seen at record time — informational only, never replayed (refs are per-snapshot). */
  ref?: string;
  /** ARIA role of the target, for self-healing. */
  role?: string;
  /** Accessible name of the target, for self-healing. */
  name?: string;
  /** wait: visible text to wait for. click: visible text of the target (healing hint). */
  text?: string;
  /** fill/type: value. select: single option. history: back|forward|reload. tab: new|switch|close. */
  value?: string;
  /** select: several options (multi-select). */
  values?: string[];
  /** upload: file paths (relative paths resolve against the run's cwd). */
  files?: string[];
  /** press: key or combo ("Enter", "Control+A"). */
  key?: string;
  /** scroll direction (default down) and pixel amount (default 600). */
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  /** tab switch/close: 0-based tab index. */
  index?: number;
  /** navigate: open in a new tab instead of the active one. */
  newTab?: boolean;
  /** click: double-click / mouse button / held modifier keys (Control+click opens a new tab). */
  double?: boolean;
  button?: 'left' | 'right' | 'middle';
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>;
  /** wait: fixed delay. Other kinds: extra pause AFTER the step. */
  waitMs?: number;
  /** A failure of this step is reported but doesn't stop the replay (cookie banners etc). */
  optional?: boolean;
  note?: string;
  /** Who performed the step while recording. */
  actor?: 'agent' | 'human';
}

export interface Workflow {
  /** Normalized id: `[a-z0-9][a-z0-9-]*` (also the file name). */
  name: string;
  /** Original display name when it differs from `name` (e.g. a Persian title). */
  title?: string;
  description: string;
  version: 1;
  /** ISO timestamp. */
  createdAt: string;
  updatedAt?: string;
  source: WorkflowSource;
  startUrl?: string;
  params: WorkflowParam[];
  steps: WorkflowStep[];
}

export interface WorkflowSummary {
  name: string;
  title?: string;
  description: string;
  source: WorkflowSource;
  steps: number;
  params: Array<{ name: string; secret?: boolean; required: boolean }>;
  createdAt: string;
  updatedAt?: string;
  startUrl?: string;
  file: string;
}

// ── names ────────────────────────────────────────────────────────────────────

export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PARAM_NAME_RE = /^[a-z_][a-z0-9_]{0,63}$/;

/**
 * Turn any user/model-supplied name into a safe workflow id (`[a-z0-9-]`).
 * Non-ASCII names (e.g. Persian "خرید از دیجی‌کالا") keep their ASCII part and get
 * a short deterministic hash suffix, so the SAME input always maps to the SAME id
 * (users can keep referring to the workflow by its original name) and two
 * different Persian names never collide. Returns '' for empty input.
 */
export function normalizeWorkflowName(raw: string): string {
  const original = String(raw ?? '').normalize('NFC').trim();
  if (!original) return '';
  const lower = original.toLowerCase();
  let slug = lower
    .replace(/[\s_./\\:]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  // eslint-disable-next-line no-control-regex
  const hasNonAscii = /[^\x00-\x7f]/.test(lower);
  if (hasNonAscii || !slug) {
    const h = createHash('sha1').update(lower).digest('hex').slice(0, 6);
    slug = (slug ? slug.slice(0, 48) + '-' : 'wf-') + h;
  }
  return slug.slice(0, 64).replace(/-+$/g, '');
}

export function isValidWorkflowName(name: string): boolean {
  return WORKFLOW_NAME_RE.test(name);
}

/** snake_case ASCII param name from a label ("Email address" → "email_address"); '' if none. */
export function toParamName(raw: string | undefined): string {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 40)
    .replace(/_+$/g, '');
  if (!s) return '';
  return /^[a-z_]/.test(s) ? s : `f_${s}`;
}

// ── placeholders ─────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Param names referenced as `{{name}}` in a string. */
export function placeholdersIn(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const m of s.matchAll(PLACEHOLDER_RE)) out.push(m[1]!);
  return out;
}

/** If `s` is exactly one placeholder (`{{name}}`), its param name. */
export function soloPlaceholder(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.trim().match(/^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/);
  return m ? m[1]! : null;
}

/** Every string field of a step that may carry placeholders. */
function stepStrings(step: WorkflowStep): string[] {
  return [
    step.url, step.selector, step.role, step.name, step.text, step.value, step.key,
    ...(step.values ?? []), ...(step.files ?? []),
  ].filter((x): x is string => typeof x === 'string');
}

export function stepPlaceholders(step: WorkflowStep): string[] {
  const set = new Set<string>();
  for (const s of stepStrings(step)) for (const p of placeholdersIn(s)) set.add(p);
  return [...set];
}

/** Placeholders referenced by steps[fromIndex..] (0-based), in first-use order. */
export function workflowPlaceholders(wf: Pick<Workflow, 'steps'>, fromIndex = 0): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const step of wf.steps.slice(Math.max(0, fromIndex))) {
    for (const p of stepPlaceholders(step)) {
      if (!seen.has(p)) { seen.add(p); out.push(p); }
    }
  }
  return out;
}

/**
 * Substitute `{{name}}` placeholders. Unknown names are left untouched.
 * `urlEncode`: encode values that are embedded INSIDE a larger string (query
 * strings); a placeholder that is the whole string is inserted raw, so a
 * `{{start_url}}` param can hold a full URL.
 */
export function substitute(template: string, values: Record<string, string>, opts: { urlEncode?: boolean } = {}): string {
  const solo = soloPlaceholder(template);
  if (solo !== null) return Object.prototype.hasOwnProperty.call(values, solo) ? values[solo]! : template;
  return template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return whole;
    const v = values[name]!;
    return opts.urlEncode ? encodeURIComponent(v) : v;
  });
}

// ── description ──────────────────────────────────────────────────────────────

function q(s: string, max = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return `"${t.length > max ? t.slice(0, max - 1) + '…' : t}"`;
}

/** Short, human-readable target description ("button \"Search\"", "#email"). */
export function describeTarget(step: Pick<WorkflowStep, 'selector' | 'role' | 'name' | 'text' | 'ref'>): string {
  if (step.role && step.name) return `${step.role} ${q(step.name)}`;
  if (step.name) return q(step.name);
  if (step.text) return q(step.text);
  if (step.selector) return step.selector.length > 70 ? step.selector.slice(0, 69) + '…' : step.selector;
  if (step.ref) return `ref ${step.ref} (unresolved)`;
  return 'the focused element';
}

/**
 * One-line description of a step. Uses the TEMPLATE values (placeholders stay as
 * `{{name}}`), so secrets are never printed.
 */
export function describeStep(step: WorkflowStep): string {
  const t = describeTarget(step);
  switch (step.kind) {
    case 'navigate': return `${step.newTab ? 'open new tab' : 'go to'} ${step.url ?? '(no url)'}`;
    case 'click': return `${step.modifiers?.length ? step.modifiers.join('+') + '+' : ''}${step.double ? 'double-click' : step.button === 'right' ? 'right-click' : 'click'} ${t}`;
    case 'hover': return `hover ${t}`;
    case 'fill': return `fill ${t} with ${q(step.value ?? '', 40)}`;
    case 'type': return `type ${q(step.value ?? '', 40)}${step.selector || step.role || step.name ? ` into ${t}` : ''}`;
    case 'select': return `select ${(step.values?.length ? step.values : [step.value ?? '']).map(v => q(v, 30)).join(', ')} in ${t}`;
    case 'press': return `press ${step.key ?? '?'}${step.selector || step.role || step.name ? ` on ${t}` : ''}`;
    case 'scroll': return `scroll ${step.direction ?? 'down'}${step.amount ? ` ${step.amount}px` : ''}${step.selector || step.name ? ` to ${t}` : ''}`;
    case 'wait':
      if (step.text) return `wait for text ${q(step.text)}`;
      if (step.selector) return `wait for ${step.selector}`;
      if (step.url) return `wait for URL ${step.url}`;
      return `wait ${step.waitMs ?? 0}ms`;
    case 'upload': return `upload ${(step.files ?? []).join(', ')} to ${t}`;
    case 'extract': return `extract text${step.selector || step.name ? ` of ${t}` : ' of the page'}`;
    case 'history': return `browser ${step.value ?? 'back'}`;
    case 'tab':
      if (step.value === 'switch') return `switch to tab ${step.index ?? 0}`;
      if (step.value === 'close') return `close tab${typeof step.index === 'number' ? ` ${step.index}` : ''}`;
      return `open new tab${step.url ? ` ${step.url}` : ''}`;
    default: return String((step as WorkflowStep).kind);
  }
}

/** True when the step needs a page element to act on. */
export function stepNeedsTarget(step: WorkflowStep): boolean {
  switch (step.kind) {
    case 'click': case 'hover': case 'fill': case 'select': case 'upload': return true;
    default: return false;
  }
}

/** True when the step has something replay can resolve (refs alone don't count). */
export function stepHasReplayableTarget(step: WorkflowStep): boolean {
  return !!(step.selector || (step.role && step.name) || step.name || step.text);
}
