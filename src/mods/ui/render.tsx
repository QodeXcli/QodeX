/**
 * Ink rendering of (validated) mod element trees.
 *
 * Every tree reaching this file went through validateModTree(), so props are known and
 * well-typed; this file only maps elements onto Ink: Box → Box, Text → Text, Button →
 * `[ label ]` / `hotkey: label` (inverse while focused), Link → underlined label,
 * Markdown → the transcript's flat markdown view, Bar → one row of colored blocks plus
 * a legend, and `{ type: 'engine' }` → whatever QodeX itself draws at that site.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ModElement, ModBarProps } from '../types.js';
import { inkColor } from './validate.js';
import { StreamingView } from '../../cli/render/assistant-message.js';

export interface ModTreeContext {
  /** Columns the tree may use (the band/pane body width). */
  width: number;
  /** Key of the Button that has keyboard focus, if any. */
  focusedKey?: string | null;
  /** QodeX's own drawing for `{ type: 'engine' }` (the spinner text), if the site has one. */
  engine?: React.ReactNode;
}

type Child = ModElement | string;

/** Draw one validated tree. */
export function ModTree(props: { el: ModElement; ctx: ModTreeContext }): React.ReactElement | null {
  return renderEl(props.el, props.ctx, 'root');
}

function renderEl(el: Child, ctx: ModTreeContext, key: string): React.ReactElement | null {
  if (typeof el === 'string') return <Text key={key}>{el}</Text>;
  switch (el.type) {
    case 'engine':
      return ctx.engine ? <React.Fragment key={key}>{ctx.engine}</React.Fragment> : null;
    case 'Box': {
      const { key: _k, borderColor, ...layout } = el.props as Record<string, unknown>;
      return (
        <Box key={key} {...(layout as object)} borderColor={inkColor(borderColor as string | undefined)}>
          {(el.children as Child[]).map((c, i) => renderEl(c, ctx, `${key}.${i}`))}
        </Box>
      );
    }
    case 'Text':
      return renderText(el, key);
    case 'Button': {
      const p = el.props;
      const focused = !!ctx.focusedKey && ctx.focusedKey === p.key;
      const text = p.plain ? `${p.hotkey ? `${p.hotkey}: ` : ''}${p.label}` : `[ ${p.label} ]`;
      return (
        <Text key={key} inverse={focused} dimColor={!focused && !!p.dimColor} bold={focused}>
          {text}
        </Text>
      );
    }
    case 'Link':
      return renderLink(el.props, key);
    case 'Markdown': {
      const p = el.props;
      if (p.dimColor) {
        return (
          <Box key={key} flexDirection="column">
            {p.text.split('\n').map((ln, i) => <Text key={i} dimColor>{ln || ' '}</Text>)}
          </Box>
        );
      }
      return <StreamingView key={key} text={p.text} />;
    }
    case 'Bar':
      return <ModBar key={key} bar={el.props} width={el.props.width ?? ctx.width} />;
    default:
      return null;
  }
}

function renderText(el: Extract<ModElement, { type: 'Text' }>, key: string): React.ReactElement {
  const p = el.props;
  return (
    <Text
      key={key}
      color={inkColor(p.color)}
      backgroundColor={inkColor(p.backgroundColor)}
      bold={p.bold}
      italic={p.italic}
      underline={p.underline}
      dimColor={p.dimColor}
      inverse={p.inverse}
      wrap={p.wrap}
    >
      {el.children.map((c, i) => {
        if (typeof c === 'string') return c;
        if (c.type === 'Text') return renderText(c, `${key}.${i}`);
        if (c.type === 'Link') return renderLink(c.props, `${key}.${i}`);
        return null;
      })}
    </Text>
  );
}

function renderLink(p: { href: string; label?: string }, key: string): React.ReactElement {
  const label = p.label && p.label !== p.href ? p.label : '';
  return (
    <Text key={key}>
      <Text color="cyan" underline>{label || p.href}</Text>
      {label ? <Text dimColor>{` (${p.href})`}</Text> : null}
    </Text>
  );
}

// ── Bar ──────────────────────────────────────────────────────────────────────

/**
 * Cells per segment for a stacked bar `width` cells wide, as a share of `total`
 * (default: the segments' sum). Largest-remainder rounding, so the cells add up to the
 * filled share exactly and a non-zero segment never vanishes when there is room.
 */
export function barCells(values: number[], width: number, total?: number): { cells: number[]; empty: number } {
  const w = Math.max(0, Math.floor(width));
  const sum = values.reduce((a, b) => a + Math.max(0, b), 0);
  const denom = total !== undefined && total > 0 ? Math.max(total, sum) : sum;
  if (w === 0 || denom <= 0) return { cells: values.map(() => 0), empty: w };
  const exact = values.map(v => (Math.max(0, v) / denom) * w);
  const filled = Math.min(w, Math.round((sum / denom) * w));
  const cells = exact.map(Math.floor);
  let left = filled - cells.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x), v: values[i]! }))
    .sort((a, b) => b.r - a.r || b.v - a.v);
  // Give a cell to each visible-but-rounded-away segment first, then by remainder.
  for (const o of order) {
    if (left <= 0) break;
    if (cells[o.i] === 0 && o.v > 0) { cells[o.i]++; left--; }
  }
  for (const o of order) {
    if (left <= 0) break;
    cells[o.i]++; left--;
  }
  while (left < 0) {
    // Over-allocated (only possible with many tiny segments): take back from the largest.
    let max = 0;
    for (let i = 1; i < cells.length; i++) if (cells[i]! > cells[max]!) max = i;
    cells[max]!--; left++;
  }
  return { cells, empty: w - cells.reduce((a, b) => a + b, 0) };
}

/** 1234 → "1.2k", 1500000 → "1.5M". */
export function compactNumber(n: number): string {
  const a = Math.abs(n);
  const fmt = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1)).replace(/\.0$/, '');
  if (a >= 1_000_000) return `${fmt(n / 1_000_000)}M`;
  if (a >= 1_000) return `${fmt(n / 1_000)}k`;
  return String(Math.round(n));
}

function ModBar(props: { bar: ModBarProps; width: number }): React.ReactElement {
  const { bar } = props;
  const width = Math.max(1, Math.floor(props.width));
  const { cells, empty } = barCells(bar.segments.map(s => s.value), width, bar.total);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        {bar.segments.map((s, i) => (cells[i]! > 0 ? <Text key={i} color={inkColor(s.color)}>{'█'.repeat(cells[i]!)}</Text> : null))}
        {empty > 0 ? <Text dimColor>{'░'.repeat(empty)}</Text> : null}
      </Text>
      {bar.showLegend !== false && bar.segments.length > 0 && (
        <Text wrap="wrap">
          {bar.segments.map((s, i) => (
            <Text key={i}>
              {i > 0 ? '  ' : ''}
              <Text color={inkColor(s.color)}>■</Text>
              <Text dimColor>{` ${s.label} ${compactNumber(s.value)}`}</Text>
            </Text>
          ))}
        </Text>
      )}
    </Box>
  );
}

// ── height estimate ─────────────────────────────────────────────────────────

function textLen(children: Child[]): string {
  return children.map(c => (typeof c === 'string' ? c : c.type === 'Text' ? textLen(c.children) : c.type === 'Link' ? (c.props.label ?? c.props.href) : '')).join('');
}

function wrappedRows(s: string, width: number): number {
  const w = Math.max(1, width);
  return s.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / w)), 0);
}

/**
 * Rough number of terminal rows a tree takes at `width` columns. Ink cannot measure
 * before drawing and has no max-height, so panes and the band cap themselves with this
 * (fixed height + overflow hidden only when the estimate is over the limit).
 */
export function estimateRows(el: Child, width: number): number {
  if (typeof el === 'string') return wrappedRows(el, width);
  switch (el.type) {
    case 'engine':
    case 'Button':
    case 'Link':
      return 1;
    case 'Text': {
      const s = textLen(el.children);
      return el.props.wrap && el.props.wrap !== 'wrap' ? s.split('\n').length : wrappedRows(s, width);
    }
    case 'Markdown':
      return wrappedRows(el.props.text, width);
    case 'Bar': {
      if (el.props.showLegend === false || el.props.segments.length === 0) return 1;
      const legend = el.props.segments.map(s => `■ ${s.label} ${compactNumber(s.value)}`).join('  ');
      return 1 + wrappedRows(legend, el.props.width ?? width);
    }
    case 'Box': {
      const p = el.props as Record<string, number | string | undefined>;
      const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0);
      const border = p.borderStyle ? 1 : 0;
      const padX = num('paddingX') || num('padding');
      const padY = num('paddingY') || num('padding');
      const inner = Math.max(1, width - 2 * padX - 2 * border - num('paddingLeft') - num('paddingRight'));
      const kids = el.children as Child[];
      const row = p.flexDirection === 'row' || p.flexDirection === 'row-reverse';
      const gap = row ? 0 : (num('rowGap') || num('gap'));
      const body = row
        ? kids.reduce((m, c) => Math.max(m, estimateRows(c, Math.max(1, Math.floor(inner / Math.max(1, kids.length))))), 0)
        : kids.reduce((n, c) => n + estimateRows(c, inner), 0) + gap * Math.max(0, kids.length - 1);
      const fixed = typeof p.height === 'number' ? p.height : undefined;
      return (fixed ?? body + 2 * padY + num('paddingTop') + num('paddingBottom') + 2 * border)
        + num('marginTop') + num('marginBottom') + 2 * (num('marginY') || num('margin'));
    }
    default:
      return 1;
  }
}
