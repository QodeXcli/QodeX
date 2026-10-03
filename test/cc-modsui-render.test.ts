/**
 * Mods UI (src/mods/ui): tree validation and Ink rendering of the element trees mods
 * return from `ui.render` — the band, panes, status lines, toasts and history lines.
 * Rendered to a string through Ink with a fake stdout (no TTY needed).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { EventEmitter } from 'events';
import { render, Text as InkText } from 'ink';
import { validateModTree, collectButtons, isValidColor } from '../src/mods/ui/validate.js';
import { ModTree, barCells, compactNumber, estimateRows } from '../src/mods/ui/render.js';
import { ModsBand, ModsPanes, ModsStatusLines, ModsToasts, ModHistoryLineView, ModsSpinnerWord } from '../src/mods/ui/components.js';
import type { ModsUiSnapshot } from '../src/mods/ui/controller.js';
import type { ModElement } from '../src/mods/types.js';

const ANSI = /\u001b\[[0-9;]*m/g;

function renderToString(el: React.ReactElement, columns = 80): string {
  const stdout = new EventEmitter() as unknown as NodeJS.WriteStream & { columns: number; rows: number };
  const frames: string[] = [];
  Object.assign(stdout, { columns, rows: 40, isTTY: false, write: (s: string) => { frames.push(s); return true; } });
  const inst = render(el, { stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  inst.unmount();
  const last = frames.filter(f => f.trim()).pop() ?? '';
  return last.replace(ANSI, '');
}

// Element helpers mirroring $.ui.resolve(e) factories.
const Text = (children: Array<string | ModElement>, props: Record<string, unknown> = {}): ModElement =>
  ({ type: 'Text', props, children } as ModElement);
const Box = (children: ModElement[], props: Record<string, unknown> = {}): ModElement =>
  ({ type: 'Box', props, children } as ModElement);
const Button = (props: Record<string, unknown>): ModElement => ({ type: 'Button', props, children: [] } as unknown as ModElement);

const snap = (over: Partial<ModsUiSnapshot>): ModsUiSnapshot => ({
  band: [], panes: [], activePane: null, statuses: [], toasts: [], spinner: null, focus: null, focusedKey: null, ...over,
});

describe('validateModTree', () => {
  it('accepts the documented elements and normalizes children', () => {
    const r = validateModTree({
      type: 'Box', props: { flexDirection: 'column', columnGap: 2 },
      children: [
        { type: 'Text', props: { bold: true, color: 'cyan' }, children: ['n=', 3, null, false, { type: 'Text', props: {}, children: ['!'] }] },
        null,
        { type: 'Button', props: { key: 'go', label: 'Go', hotkey: 'g', onPress: () => {} }, children: [] },
        { type: 'Link', props: { href: 'https://example.com', label: 'site' }, children: [] },
        { type: 'Markdown', props: { text: '# hi\n- a' }, children: [] },
        { type: 'Bar', props: { segments: [{ label: 'a', value: 1, color: 'red' }], total: 10 }, children: [] },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const box = r.tree as Extract<ModElement, { type: 'Box' }>;
    expect(box.children).toHaveLength(5);
    expect((box.children[0] as Extract<ModElement, { type: 'Text' }>).children.slice(0, 2)).toEqual(['n=', '3']);
  });

  it('refuses unknown elements and props with a readable reason', () => {
    expect(validateModTree({ type: 'Blink', props: {}, children: [] })).toEqual({ ok: false, reason: 'element "Blink" is not allowed' });
    expect(validateModTree(Text(['x'], { bogusProp: 1 }))).toEqual({ ok: false, reason: 'Text prop "bogusProp" is not allowed' });
    expect(validateModTree(Text(['x'], { bold: 'yes' }))).toEqual({ ok: false, reason: 'Text prop "bold" has an invalid value' });
    expect(validateModTree(Text(['x'], { color: 'constructor' })).ok).toBe(false);
    expect(validateModTree(Box([], { borderStyle: 'zigzag' })).ok).toBe(false);
  });

  it('refuses children in the wrong place and oversized text', () => {
    expect(validateModTree({ type: 'Box', props: {}, children: ['raw text'] }).ok).toBe(false);
    expect(validateModTree(Text([Box([])])).ok).toBe(false);
    expect(validateModTree({ type: 'Button', props: { key: 'k', label: 'l' }, children: [Text(['x'])] }).ok).toBe(false);
    expect(validateModTree(Button({ label: 'no key' })).ok).toBe(false);
    expect(validateModTree(Button({ key: 'k', label: 'l', hotkey: 'Ctrl' })).ok).toBe(false);
    expect(validateModTree(Text(['x'.repeat(10_001)])).ok).toBe(false);
    expect(validateModTree({ type: 'Bar', props: { segments: [{ label: 'a', value: -1, color: 'red' }] }, children: [] }).ok).toBe(false);
    expect(validateModTree('just a string').ok).toBe(false);
    expect(validateModTree(null).ok).toBe(false);
  });

  it('refuses trees that are too deep or too large', () => {
    let deep: ModElement = Text(['x']);
    for (let i = 0; i < 40; i++) deep = Box([deep]);
    expect(validateModTree(deep)).toMatchObject({ ok: false });
    const wide = Box(Array.from({ length: 2500 }, () => Text(['x'])));
    expect(validateModTree(wide)).toMatchObject({ ok: false, reason: expect.stringContaining('more than') });
  });

  it('keeps engine references and accepts theme colors', () => {
    expect(validateModTree({ type: 'engine', ref: 'Spinner' })).toEqual({ ok: true, tree: { type: 'engine', ref: 'Spinner' } });
    for (const c of ['red', 'success', '#abc', '#a1b2c3', 'rgb(1,2,3)', 'ansi256(12)']) expect(isValidColor(c)).toBe(true);
    for (const c of ['nope', '#12', 'level', '']) expect(isValidColor(c)).toBe(false);
  });

  it('collects buttons in drawing order', () => {
    const r = validateModTree(Box([Button({ key: 'a', label: 'A' }), Box([Button({ key: 'b', label: 'B', hotkey: '2', autoFocus: true })])]));
    expect(r.ok && collectButtons(r.tree).map(b => [b.key, b.hotkey, b.autoFocus])).toEqual([['a', undefined, undefined], ['b', '2', true]]);
  });
});

describe('barCells / compactNumber / estimateRows', () => {
  it('fills the share of the total and keeps small non-zero segments visible', () => {
    expect(barCells([50, 25], 20, 100)).toEqual({ cells: [10, 5], empty: 5 });
    const r = barCells([1000, 1, 1], 10, 1002);
    expect(r.cells.reduce((a, b) => a + b, 0) + r.empty).toBe(10);
    expect(r.cells[1]).toBeGreaterThan(0);
    expect(barCells([0, 0], 10)).toEqual({ cells: [0, 0], empty: 10 });
    expect(barCells([5, 5], 10).empty).toBe(0);
  });

  it('formats numbers compactly', () => {
    expect(compactNumber(950)).toBe('950');
    expect(compactNumber(1234)).toBe('1.2k');
    expect(compactNumber(200_000)).toBe('200k');
    expect(compactNumber(1_000_000)).toBe('1M');
  });

  it('estimates rows for columns, rows, borders and wrapping', () => {
    expect(estimateRows(Box([Text(['a']), Text(['b'])], { flexDirection: 'column' }), 40)).toBe(2);
    expect(estimateRows(Box([Text(['a']), Text(['b'])], { flexDirection: 'row' }), 40)).toBe(1);
    expect(estimateRows(Box([Text(['a'])], { borderStyle: 'round' }), 40)).toBe(3);
    expect(estimateRows(Text(['x'.repeat(100)]), 40)).toBe(3);
  });
});

describe('ModTree rendering', () => {
  it('draws text, buttons (plain and bracketed), links and markdown', () => {
    const tree = Box([
      Text(['Hello ', Text(['world'], { bold: true })]),
      Box([Button({ key: 'one', label: 'One', hotkey: '1', plain: true }), Button({ key: 'more', label: 'Add one' })], { flexDirection: 'row', columnGap: 2 }),
      { type: 'Link', props: { href: 'https://qodex.dev', label: 'docs' }, children: [] } as ModElement,
      { type: 'Markdown', props: { text: '- item **bold**' }, children: [] } as ModElement,
    ], { flexDirection: 'column' });
    const out = renderToString(React.createElement(ModTree, { el: tree, ctx: { width: 60 } }));
    expect(out).toContain('Hello world');
    expect(out).toContain('1: One');
    expect(out).toContain('[ Add one ]');
    expect(out).toContain('docs (https://qodex.dev)');
    expect(out).toContain('item');
  });

  it('draws a stacked bar with a legend', () => {
    const bar = { type: 'Bar', props: { width: 20, total: 100, segments: [{ label: 'system', value: 50, color: 'blue' }, { label: 'free', value: 0, color: 'gray' }] }, children: [] } as ModElement;
    const out = renderToString(React.createElement(ModTree, { el: bar, ctx: { width: 40 } }));
    const [line, legend] = out.split('\n');
    expect(line).toBe('█'.repeat(10) + '░'.repeat(10));
    expect(legend).toContain('■ system 50');
  });

  it('draws the engine reference where the site has its own drawing', () => {
    const tree = Box([{ type: 'engine', ref: 'Spinner' } as ModElement, Text(['· 3 calls'])], { flexDirection: 'row', columnGap: 1 });
    const out = renderToString(React.createElement(ModTree, { el: tree, ctx: { width: 40, engine: React.createElement(InkText, null, 'crafting…') } }));
    expect(out).toContain('crafting… · 3 calls');
  });
});

describe('mods UI components', () => {
  it('band stacks every mod tree; nothing drawn when empty', () => {
    expect(renderToString(React.createElement(ModsBand, { snap: snap({}), width: 60, maxRows: 5 }))).toBe('');
    const out = renderToString(React.createElement(ModsBand, {
      snap: snap({ band: [{ plugin: 'a', tree: Text(['first']) }, { plugin: 'b', tree: Text(['second']) }] }), width: 60, maxRows: 5,
    }));
    expect(out.split('\n').map(s => s.trim())).toEqual(['first', 'second']);
  });

  it('band is clipped to its row limit', () => {
    const tall = Box(Array.from({ length: 10 }, (_, i) => Text([`row ${i}`])), { flexDirection: 'column' });
    const out = renderToString(React.createElement(ModsBand, { snap: snap({ band: [{ plugin: 'a', tree: tall }] }), width: 60, maxRows: 3 }));
    expect(out).toContain('row 2');
    expect(out).not.toContain('row 3');
  });

  it('pane: framed with its title; several panes show tabs and the active body; focus hints', () => {
    const one = snap({ panes: [{ id: 'p1', plugin: 'm', title: 'Hello tabs', tree: Text(['body one']) }], activePane: 'p1' });
    const out1 = renderToString(React.createElement(ModsPanes, { snap: one, width: 70, maxRows: () => 5 }));
    expect(out1).toContain('Hello tabs');
    expect(out1).toContain('body one');
    expect(out1).toContain('^X Tab focus');
    expect(out1).toMatch(/╭/);

    const two = snap({
      panes: [
        { id: 'p1', plugin: 'm', title: 'One', tree: Text(['body one']) },
        { id: 'p2', plugin: 'm', title: 'Two', tree: Box([Button({ key: 'b', label: 'Press' })]) },
      ],
      activePane: 'p2', focus: { kind: 'pane', id: 'p2' }, focusedKey: 'b',
    });
    const out2 = renderToString(React.createElement(ModsPanes, { snap: two, width: 80, maxRows: () => 5 }));
    expect(out2).toContain('One');
    expect(out2).toContain(' Two ');
    expect(out2).toContain('[ Press ]');
    expect(out2).not.toContain('body one');
    expect(out2).toContain('Esc back');
  });

  it('status lines, toasts and history lines use the documented prefixes', () => {
    const s = snap({ statuses: [{ plugin: 'ctx', text: '82% of the window' }], toasts: [{ id: 1, plugin: 'hello', text: 'saved' }] });
    expect(renderToString(React.createElement(ModsStatusLines, { snap: s, width: 60 }))).toContain('⚠ ctx: 82% of the window');
    expect(renderToString(React.createElement(ModsToasts, { snap: s, width: 60 }))).toContain('◆ hello: saved');
    expect(renderToString(React.createElement(ModHistoryLineView, { line: { kind: 'log', plugin: 'm', text: 'did a thing' } }))).toBe('● m: did a thing');
    expect(renderToString(React.createElement(ModHistoryLineView, { line: { kind: 'notice', plugin: 'ysk', text: 'tests failed' } }))).toBe('💡 ysk: tests failed');
  });

  it('spinner word gets the suffix, or a tree that embeds the engine word', () => {
    expect(renderToString(React.createElement(ModsSpinnerWord, { spinner: { suffix: ' · tool calls: 2…' }, word: 'crafting', width: 40 }))).toBe('crafting · tool calls: 2…');
    expect(renderToString(React.createElement(ModsSpinnerWord, { spinner: null, word: 'crafting', width: 40 }))).toBe('crafting…');
    const tree = Box([{ type: 'engine', ref: 'Spinner' } as ModElement, Text([' (mod)'])], { flexDirection: 'row' });
    expect(renderToString(React.createElement(ModsSpinnerWord, { spinner: { tree }, word: 'crafting', width: 40 }))).toBe('crafting… (mod)');
  });
});
