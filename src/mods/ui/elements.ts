/**
 * The element factories a `ui.render` hook gets from `$.ui.resolve(e)`:
 * `Text({ children: ['hi'], bold: true })` → `{ type: 'Text', props: { bold: true }, children: ['hi'] }`.
 *
 * They only build plain data — nothing is checked here. The TUI validates every tree
 * before drawing (validate.ts), so a factory call with a bad prop still gets a readable
 * refusal instead of a crash. The runtime hands this object out as `$.ui.resolve(e)` on
 * every surface (the headless surface ignores what is drawn).
 */

import type { ModElement, ModElements } from '../types.js';

function split(props: unknown): { rest: Record<string, unknown>; children: unknown[] } {
  const p = props && typeof props === 'object' && !Array.isArray(props) ? { ...(props as Record<string, unknown>) } : {};
  const kids = p.children;
  delete p.children;
  const children = kids === undefined || kids === null ? [] : Array.isArray(kids) ? kids : [kids];
  return { rest: p, children };
}

function element(type: string, props: unknown): ModElement {
  const { rest, children } = split(props);
  // Leaf elements (Button, Link…) keep stray children too, so validation refuses them by name.
  return { type, props: rest, children } as unknown as ModElement;
}

/**
 * Claude Code elements QodeX does not draw. They still exist as factories, so a Claude
 * Code mod that destructures one gets the readable refusal (`element "Input" is not
 * allowed`) for the tree that uses it instead of a TypeError for the whole hook.
 */
export const UNSUPPORTED_ELEMENTS = ['Code', 'Input', 'Select', 'Svg', 'Client', 'Raster', 'Image'] as const;

/** Fresh factories (plain functions, safe to destructure). */
export function createModElements(): ModElements {
  const supported: ModElements = {
    Box: props => element('Box', props),
    Text: props => element('Text', props),
    Button: props => element('Button', props),
    Link: props => element('Link', props),
    Markdown: props => element('Markdown', props),
    Bar: props => element('Bar', props),
  };
  const extra: Record<string, (props: unknown) => ModElement> = {};
  for (const name of UNSUPPORTED_ELEMENTS) extra[name] = props => element(name, props);
  return Object.assign(extra, supported);
}
