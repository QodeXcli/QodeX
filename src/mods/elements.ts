/**
 * Element factories handed to ui.render hooks by $.ui.resolve(e). They build the plain-data
 * ModElement trees the TUI draws: `Text({ children: ['hi'], bold: true })`. Falsy children
 * (null / undefined / false) are dropped and numbers become strings, so a hook can write
 * `cond && Text(...)` inline. Validation (unknown element / prop, size limits) is the
 * renderer's job (src/mods/ui) — the factories only shape the data.
 */
import type { ModElement, ModElements } from './types.js';

type Child = ModElement | string | number | null | undefined | false;

function kids(children: Child[] | undefined, allowText: boolean): Array<string | ModElement> {
  const out: Array<string | ModElement> = [];
  for (const c of children ?? []) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'number') { if (allowText) out.push(String(c)); continue; }
    if (typeof c === 'string') { if (allowText) out.push(c); continue; }
    out.push(c);
  }
  return out;
}

function propsOf<T extends object>(p: T): Omit<T, 'children'> {
  const { children: _children, ...rest } = p as T & { children?: unknown };
  return rest;
}

export const MOD_ELEMENTS: ModElements = {
  Box: (p) => ({ type: 'Box', props: propsOf(p), children: kids(p.children, false) as ModElement[] }),
  Text: (p) => ({ type: 'Text', props: propsOf(p), children: kids(p.children, true) }),
  Button: (p) => ({ type: 'Button', props: { ...p }, children: [] }),
  Link: (p) => ({ type: 'Link', props: { ...p }, children: [] }),
  Markdown: (p) => ({ type: 'Markdown', props: { ...p }, children: [] }),
  Bar: (p) => ({ type: 'Bar', props: { ...p, segments: [...(p.segments ?? [])] }, children: [] }),
};

/** A plain element object (shape only: a string `type`). */
export function isModElement(v: unknown): v is ModElement {
  return !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

/** Depth-first search for the first element matching `pred`. */
export function findModElement(root: ModElement | null | undefined, pred: (el: ModElement) => boolean): ModElement | undefined {
  if (!root) return undefined;
  if (pred(root)) return root;
  const children = (root as { children?: unknown[] }).children ?? [];
  for (const c of children) {
    if (isModElement(c)) {
      const hit = findModElement(c, pred);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The text of an element and its descendants, concatenated. */
export function modElementText(el: ModElement): string {
  const children = (el as { children?: unknown[] }).children ?? [];
  return children.map(c => (typeof c === 'string' ? c : isModElement(c) ? modElementText(c) : '')).join('');
}
