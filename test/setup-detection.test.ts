import { describe, it, expect } from 'vitest';
import {
  looksVisionCapable,
  guessContextWindow,
} from '../src/setup/model-detector.js';

describe('looksVisionCapable', () => {
  it('flags Gemma 4 (multimodal)', () => {
    expect(looksVisionCapable('gemma-4-31b-it-uncensored-abliterix-mlx-int8-affine')).toBe(true);
  });
  it('flags qwen *vl* variants', () => {
    expect(looksVisionCapable('qwen2.5vl:32b')).toBe(true);
    expect(looksVisionCapable('qwen3-vl-32b')).toBe(true);
  });
  it('flags llama vision', () => {
    expect(looksVisionCapable('llama3.2-vision:11b')).toBe(true);
  });
  it('does NOT flag text-only coder / 235b', () => {
    expect(looksVisionCapable('qwen/qwen3-coder-next')).toBe(false);
    expect(looksVisionCapable('qwen3-235b-a22b-instruct-2507-mlx')).toBe(false);
  });
  it('does not false-positive on words containing "vl"', () => {
    expect(looksVisionCapable('vlad-model')).toBe(false);
  });
});

describe('guessContextWindow', () => {
  it('gives Gemma 4 a large RAM-safe window (not 32768)', () => {
    expect(guessContextWindow('gemma-4-31b-it-uncensored-abliterix-mlx-int8-affine')).toBe(131072);
  });
  it('gives qwen3-coder/235b large windows', () => {
    expect(guessContextWindow('qwen/qwen3-coder-next')).toBe(131072);
    expect(guessContextWindow('qwen3-235b-a22b-instruct-2507-mlx')).toBe(131072);
  });
  it('falls back to 32768 for unknown ids', () => {
    expect(guessContextWindow('some-unknown-model')).toBe(32768);
  });
});
