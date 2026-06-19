import { describe, it, expect } from 'vitest';
import {
  hexToRgb, rgbToHex, lerp, lerpColor, sampleStops, wrapPhase, AURORA,
} from '../src/cli/prompts/gradient.js';
import { buildBootSteps } from '../src/cli/prompts/boot-steps.js';

describe('hexToRgb / rgbToHex', () => {
  it('parses 6-digit hex', () => {
    expect(hexToRgb('#ff8800')).toEqual([255, 136, 0]);
  });
  it('expands 3-digit shorthand', () => {
    expect(hexToRgb('#f80')).toEqual([255, 136, 0]);
  });
  it('round-trips through rgbToHex', () => {
    expect(rgbToHex(hexToRgb('#22d3ee'))).toBe('#22d3ee');
  });
  it('clamps out-of-range channels', () => {
    expect(rgbToHex([300, -10, 128])).toBe('#ff0080');
  });
});

describe('lerp / lerpColor', () => {
  it('interpolates scalars', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });
  it('interpolates colours channel-wise', () => {
    expect(lerpColor([0, 0, 0], [255, 100, 50], 0.5)).toEqual([127.5, 50, 25]);
  });
});

describe('sampleStops', () => {
  const stops = [hexToRgb('#000000'), hexToRgb('#ffffff')];
  it('returns the first stop at p=0 and last at p=1', () => {
    expect(sampleStops(stops, 0)).toEqual([0, 0, 0]);
    expect(sampleStops(stops, 1)).toEqual([255, 255, 255]);
  });
  it('returns the midpoint at p=0.5', () => {
    expect(sampleStops(stops, 0.5)).toEqual([127.5, 127.5, 127.5]);
  });
  it('clamps p outside [0,1]', () => {
    expect(sampleStops(stops, -1)).toEqual([0, 0, 0]);
    expect(sampleStops(stops, 5)).toEqual([255, 255, 255]);
  });
  it('handles a single stop', () => {
    expect(sampleStops([[10, 20, 30]], 0.7)).toEqual([10, 20, 30]);
  });
  it('navigates multi-stop palettes', () => {
    // AURORA has 6 stops; p=0 is the first (teal), p=1 the last (pink).
    expect(sampleStops(AURORA, 0)).toEqual(hexToRgb('#2dd4bf'));
    expect(sampleStops(AURORA, 1)).toEqual(hexToRgb('#ec4899'));
  });
});

describe('wrapPhase', () => {
  it('wraps into [0,1)', () => {
    expect(wrapPhase(0.25)).toBeCloseTo(0.25);
    expect(wrapPhase(1.25)).toBeCloseTo(0.25);
    expect(wrapPhase(-0.25)).toBeCloseTo(0.75);
  });
});

describe('buildBootSteps', () => {
  it('reflects real runtime counts and flags', () => {
    const steps = buildBootSteps({ modelCount: 3, toolCount: 61, model: 'qwen/qwen3-coder-next', autoRetrieve: true });
    expect(steps).toHaveLength(6);
    expect(steps[0]!.label).toBe('Model router');
    expect(steps[0]!.detail).toContain('3 models online');
    expect(steps[0]!.detail).toContain('qwen/qwen3-coder-next');
    expect(steps[1]!.detail).toContain('61 tools');
    expect(steps.find(s => s.label === 'Semantic retrieval')!.detail).toBe('auto-context enabled');
  });
  it('singularizes one model and warns on zero', () => {
    expect(buildBootSteps({ modelCount: 1, toolCount: 10, model: 'm', autoRetrieve: false })[0]!.detail).toContain('1 model online');
    expect(buildBootSteps({ modelCount: 0, toolCount: 10, model: 'm', autoRetrieve: false })[0]!.detail).toContain('no models yet');
  });
  it('shows on-demand retrieval and a draft model when set', () => {
    const steps = buildBootSteps({ modelCount: 2, toolCount: 10, model: 'm', autoRetrieve: false, draftModel: 'qwen0.5b' });
    expect(steps.find(s => s.label === 'Semantic retrieval')!.detail).toBe('on demand');
    expect(steps.find(s => s.label === 'Constrained decoding')!.detail).toContain('draft qwen0.5b');
  });
});
