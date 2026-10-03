/**
 * Validation of the element trees mods return from `ui.render`.
 *
 * A tree is plain data from someone else's code, so the TUI checks every node before
 * drawing: known element types only, known props only (with the right value types),
 * the right kind of children in the right places, and size limits. Anything off →
 * the whole tree is refused with one readable reason, the TUI logs
 * `ui.render (<Site>) refused: <reason>` and draws nothing for that mod.
 *
 * The result is a normalized copy: null/false/undefined children dropped, numbers in
 * Text turned into strings, children arrays always present.
 */

import { MOD_LIMITS, type ModElement } from '../types.js';

export type ValidateResult = { ok: true; tree: ModElement } | { ok: false; reason: string };

const MAX_DEPTH = 32;
const MAX_NODES = 2000;
const MAX_BAR_SEGMENTS = 32;

const NAMED_COLORS = new Set([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
  'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright', 'magentaBright',
  'cyanBright', 'whiteBright',
]);

/** Claude Code theme keys a mod may use as colors, mapped to terminal colors. */
export const THEME_COLORS: Readonly<Record<string, string>> = {
  success: 'green', error: 'red', warning: 'yellow', info: 'cyan', suggestion: 'cyan',
  permission: 'magenta', claude: '#d97757', accent: 'cyan', inactive: 'gray', subtle: 'gray',
  text: 'white', secondaryText: 'gray',
};

/** A color Ink can draw: a named color, a theme key, #rgb/#rrggbb, rgb(r,g,b) or ansi256(n). */
export function isValidColor(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 32) return false;
  if (NAMED_COLORS.has(v) || Object.prototype.hasOwnProperty.call(THEME_COLORS, v)) return true;
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return true;
  if (/^rgb\(\s?\d{1,3},\s?\d{1,3},\s?\d{1,3}\s?\)$/.test(v)) return true;
  return /^ansi256\(\s?\d{1,3}\s?\)$/.test(v);
}

/** The color to hand Ink (theme keys resolved). */
export function inkColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return THEME_COLORS[v] ?? v;
}

type Check = (v: unknown) => boolean;
const isBool: Check = v => typeof v === 'boolean';
const isTrue: Check = v => v === true;
const isStr: Check = v => typeof v === 'string';
const isNum: Check = v => typeof v === 'number' && Number.isFinite(v);
const isSpace: Check = v => isNum(v) && (v as number) >= 0 && (v as number) <= 200;
const isSize: Check = v => (isNum(v) && (v as number) >= 0 && (v as number) <= 1000) || (typeof v === 'string' && /^\d{1,3}%$/.test(v));
const isFn: Check = v => typeof v === 'function';
const oneOf = (...vals: string[]): Check => v => typeof v === 'string' && vals.includes(v);

// Box layout props. The ModBoxProps set, plus the Ink layout props a Claude Code mod
// commonly passes (all harmless to draw).
const BOX_PROPS: Record<string, Check> = {
  key: isStr,
  flexDirection: oneOf('row', 'column', 'row-reverse', 'column-reverse'),
  columnGap: isSpace, rowGap: isSpace, gap: isSpace,
  padding: isSpace, paddingX: isSpace, paddingY: isSpace,
  paddingTop: isSpace, paddingBottom: isSpace, paddingLeft: isSpace, paddingRight: isSpace,
  margin: isSpace, marginX: isSpace, marginY: isSpace,
  marginTop: isSpace, marginBottom: isSpace, marginLeft: isSpace, marginRight: isSpace,
  width: isSize, height: isSize, minWidth: isSize, minHeight: isSize,
  flexGrow: isSpace, flexShrink: isSpace,
  flexWrap: oneOf('nowrap', 'wrap', 'wrap-reverse'),
  alignItems: oneOf('flex-start', 'center', 'flex-end', 'stretch'),
  justifyContent: oneOf('flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'),
  borderStyle: oneOf('single', 'round', 'double', 'bold', 'singleDouble', 'doubleSingle', 'classic'),
  borderColor: isValidColor,
  borderDimColor: isBool,
};

const TEXT_PROPS: Record<string, Check> = {
  key: isStr,
  color: isValidColor, backgroundColor: isValidColor,
  bold: isBool, italic: isBool, underline: isBool, strikethrough: isBool, dimColor: isBool, inverse: isBool,
  wrap: oneOf('wrap', 'truncate', 'truncate-start', 'truncate-middle', 'truncate-end'),
};

const BUTTON_PROPS: Record<string, Check> = {
  key: isStr, label: isStr,
  hotkey: v => typeof v === 'string' && /^[0-9a-z]$/.test(v),
  plain: isBool, dimColor: isBool, onPress: isFn, autoFocus: isTrue,
  // Claude Code binds a keybinding action to a button; QodeX accepts and ignores it.
  action: isStr,
};

const LINK_PROPS: Record<string, Check> = { key: isStr, href: isStr, label: isStr };

const MARKDOWN_PROPS: Record<string, Check> = {
  key: isStr,
  text: v => typeof v === 'string' && v.length <= MOD_LIMITS.textChildChars,
  dimColor: isBool,
};

const BAR_PROPS: Record<string, Check> = {
  key: isStr,
  width: v => isNum(v) && (v as number) >= 1 && (v as number) <= 1000,
  total: v => isNum(v) && (v as number) >= 0,
  showLegend: isBool,
  segments: v => Array.isArray(v) && v.length <= MAX_BAR_SEGMENTS,
};

const PROPS_BY_TYPE: Record<string, Record<string, Check>> = {
  Box: BOX_PROPS, Text: TEXT_PROPS, Button: BUTTON_PROPS, Link: LINK_PROPS, Markdown: MARKDOWN_PROPS, Bar: BAR_PROPS,
};

const REQUIRED: Record<string, string[]> = {
  Button: ['key', 'label'], Link: ['href'], Markdown: ['text'], Bar: ['segments'],
};

class Refused extends Error {}

function fail(msg: string): never {
  throw new Refused(msg);
}

/** Validate (and normalize) a tree a mod returned. Never throws. */
export function validateModTree(input: unknown): ValidateResult {
  let nodes = 0;

  const describe = (v: unknown): string => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'an array';
    return typeof v === 'object' ? 'an object' : typeof v;
  };

  const walk = (v: unknown, depth: number, parent: string | null): ModElement | string | null => {
    if (v === null || v === undefined || v === false) return null;
    if (typeof v === 'string' || typeof v === 'number') {
      if (parent !== 'Text') fail(`${parent ?? 'the site'} cannot hold a text child (wrap text in Text)`);
      const s = String(v);
      if (s.length > MOD_LIMITS.textChildChars) fail(`a Text child is longer than ${MOD_LIMITS.textChildChars} characters`);
      return s;
    }
    if (typeof v !== 'object' || Array.isArray(v)) fail(`an element is ${describe(v)}, not an element object`);
    if (++nodes > MAX_NODES) fail(`the tree has more than ${MAX_NODES} elements`);
    if (depth > MAX_DEPTH) fail(`the tree is deeper than ${MAX_DEPTH} levels`);

    const el = v as Record<string, unknown>;
    const type = el.type;
    if (type === 'engine') {
      if (typeof el.ref !== 'string') fail('an engine element has no ref');
      return { type: 'engine', ref: el.ref as string };
    }
    if (typeof type !== 'string' || !PROPS_BY_TYPE[type]) fail(`element "${String(type)}" is not allowed`);
    const t = type as string;
    if (parent === 'Text' && t !== 'Text' && t !== 'Link') fail(`Text cannot hold a ${t}`);

    const rawProps = el.props === undefined ? {} : el.props;
    if (rawProps === null || typeof rawProps !== 'object' || Array.isArray(rawProps)) fail(`${t} props are ${describe(rawProps)}`);
    const allowed = PROPS_BY_TYPE[t]!;
    const props: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(rawProps as Record<string, unknown>)) {
      if (name === 'children') continue; // factories may leave it in props; the real children are el.children
      if (value === undefined) continue;
      const check = allowed[name];
      if (!check) fail(`${t} prop "${name}" is not allowed`);
      if (!check(value)) fail(`${t} prop "${name}" has an invalid value`);
      props[name] = value;
    }
    for (const req of REQUIRED[t] ?? []) {
      if (props[req] === undefined) fail(`${t} needs a "${req}" prop`);
    }
    if (t === 'Bar') props.segments = checkSegments(props.segments as unknown[]);

    const rawChildren = el.children === undefined ? [] : el.children;
    if (!Array.isArray(rawChildren)) fail(`${t} children are ${describe(rawChildren)}, not a list`);
    const kids = (rawChildren as unknown[]).filter(c => c !== null && c !== undefined && c !== false);
    if ((t === 'Button' || t === 'Link' || t === 'Markdown' || t === 'Bar') && kids.length > 0) {
      fail(`${t} cannot have children`);
    }
    const children = kids.map(c => walk(c, depth + 1, t)).filter((c): c is ModElement | string => c !== null);
    return { type: t, props, children } as unknown as ModElement;
  };

  try {
    const tree = walk(input, 0, null);
    if (tree === null || typeof tree === 'string') return { ok: false, reason: 'the hook returned no element' };
    return { ok: true, tree };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.message };
    return { ok: false, reason: `invalid tree (${(e as Error)?.message ?? String(e)})` };
  }
}

function checkSegments(segs: unknown[]): Array<{ label: string; value: number; color: string }> {
  return segs.map((s, i) => {
    if (!s || typeof s !== 'object') fail(`Bar segment ${i} is not an object`);
    const seg = s as Record<string, unknown>;
    for (const k of Object.keys(seg)) {
      if (k !== 'label' && k !== 'value' && k !== 'color') fail(`Bar segment prop "${k}" is not allowed`);
    }
    if (typeof seg.label !== 'string') fail(`Bar segment ${i} needs a label`);
    if (typeof seg.value !== 'number' || !Number.isFinite(seg.value) || seg.value < 0) fail(`Bar segment ${i} needs a value >= 0`);
    if (!isValidColor(seg.color)) fail(`Bar segment ${i} has an invalid color`);
    return { label: seg.label as string, value: seg.value as number, color: seg.color as string };
  });
}

/** A Button found in a validated tree, in drawing order. */
export interface ModButtonRef {
  key: string;
  label: string;
  hotkey?: string;
  autoFocus?: boolean;
  onPress?: () => void | Promise<void>;
}

/** Every Button in a (validated) tree, depth-first in drawing order. */
export function collectButtons(tree: ModElement | null | undefined): ModButtonRef[] {
  const out: ModButtonRef[] = [];
  const walk = (el: ModElement | string): void => {
    if (typeof el === 'string' || el.type === 'engine') return;
    if (el.type === 'Button') {
      const p = el.props;
      out.push({ key: p.key, label: p.label, hotkey: p.hotkey, autoFocus: (p as { autoFocus?: boolean }).autoFocus, onPress: p.onPress });
      return;
    }
    for (const c of el.children as Array<ModElement | string>) walk(c);
  };
  if (tree) walk(tree);
  return out;
}
