/**
 * Terminal gradient text — the visual primitive behind QodeX's boot splash and header.
 *
 * Ink has no native gradient, so we colour each glyph individually by interpolating
 * across a list of hex colour stops. A `phase` offset lets the gradient slide along the
 * text between frames, which is what produces the "shimmer" sweep on the logo. When the
 * terminal can't do colour (NO_COLOR / not a TTY), Ink/chalk drop the colours and the
 * text degrades to plain bold automatically — no special-casing needed here.
 *
 * The maths (hex↔rgb, lerp, multi-stop sampling) is pure and unit-tested separately.
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Sample a multi-stop gradient at position p∈[0,1]. Clamps out-of-range p. */
export function sampleStops(stops: RGB[], p: number): RGB {
  if (stops.length === 0) return [255, 255, 255];
  if (stops.length === 1) return stops[0]!;
  const clamped = Math.max(0, Math.min(1, p));
  const x = clamped * (stops.length - 1);
  const i = Math.floor(x);
  const frac = x - i;
  const a = stops[i]!;
  const b = stops[Math.min(stops.length - 1, i + 1)]!;
  return lerpColor(a, b, frac);
}

/** Wrap a phase value into [0,1) so callers can advance it without bounds-checking. */
export function wrapPhase(p: number): number {
  const m = p % 1;
  return m < 0 ? m + 1 : m;
}

/** Aurora palette — teal → cyan → blue → indigo → violet → pink. Tasteful and vivid. */
export const AURORA: RGB[] = [
  hexToRgb('#2dd4bf'),
  hexToRgb('#22d3ee'),
  hexToRgb('#3b82f6'),
  hexToRgb('#6366f1'),
  hexToRgb('#a855f7'),
  hexToRgb('#ec4899'),
];

export interface GradientTextProps {
  text: string;
  stops?: RGB[];
  /** 0..1 offset that slides the gradient along the text (animate for a shimmer). */
  phase?: number;
  bold?: boolean;
}

/**
 * Render `text` with a horizontal colour gradient, one Text node per glyph. Spaces are
 * emitted plain (colour on a space is invisible and just adds nodes).
 */
export function GradientText({ text, stops = AURORA, phase = 0, bold = false }: GradientTextProps): React.ReactElement {
  const chars = [...text];
  const denom = Math.max(1, chars.length - 1);
  return (
    <Text bold={bold}>
      {chars.map((ch, i) => {
        if (ch === ' ') return ' ';
        const p = wrapPhase(i / denom + phase);
        const color = rgbToHex(sampleStops(stops, p));
        return (
          <Text key={i} color={color}>{ch}</Text>
        );
      })}
    </Text>
  );
}

export interface GradientBarProps {
  /** Fill fraction 0..1. */
  value: number;
  width?: number;
  stops?: RGB[];
}

/** A gradient-filled progress bar: filled cells coloured along the gradient, rest dim. */
export function GradientBar({ value, width = 28, stops = AURORA }: GradientBarProps): React.ReactElement {
  const filled = Math.max(0, Math.min(width, Math.round(value * width)));
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      const color = rgbToHex(sampleStops(stops, width <= 1 ? 1 : i / (width - 1)));
      cells.push(<Text key={i} color={color}>█</Text>);
    } else {
      cells.push(<Text key={i} dimColor>░</Text>);
    }
  }
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <Text>
      {cells}
      <Text dimColor>{`  ${pct}%`}</Text>
    </Text>
  );
}

/**
 * Continuously advance a gradient `phase` so a <GradientText> shimmers. Returns the
 * current phase∈[0,1). When `enabled` is false (no TTY / motion disabled) it stays at 0
 * so the gradient renders as a pleasant static sweep instead of animating. The timer
 * lives wherever this hook is called — keep callers small so only that node repaints.
 */
export function useShimmer(enabled = true, stepMs = 95, increment = 0.045): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setPhase(p => (p + increment) % 1), stepMs);
    return () => clearInterval(t);
  }, [enabled, stepMs, increment]);
  return phase;
}
