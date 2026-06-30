import { describe, it, expect } from 'vitest';
import { parseNvidiaSmiVram, parseMacMemGB, extractBlockCount } from '../src/setup/offload-detect.ts';

describe('parseNvidiaSmiVram', () => {
  it('takes the biggest GPU and converts MiB → GB', () => {
    expect(parseNvidiaSmiVram('24576')).toBeCloseTo(24, 5);          // single 24 GiB GPU
    expect(parseNvidiaSmiVram('8192\n24576\n')).toBeCloseTo(24, 5);  // multi-GPU → biggest
  });
  it('returns null on empty / garbage', () => {
    expect(parseNvidiaSmiVram('')).toBeNull();
    expect(parseNvidiaSmiVram('N/A\n')).toBeNull();
  });
});

describe('parseMacMemGB', () => {
  it('converts hw.memsize bytes → GiB', () => {
    expect(parseMacMemGB(String(64 * 1024 ** 3))).toBeCloseTo(64, 5);
    expect(parseMacMemGB('  17179869184\n')).toBeCloseTo(16, 5);
  });
  it('returns null on junk', () => {
    expect(parseMacMemGB('nope')).toBeNull();
    expect(parseMacMemGB('0')).toBeNull();
  });
});

describe('extractBlockCount', () => {
  it('finds the arch-prefixed block_count key', () => {
    expect(extractBlockCount({ 'qwen3.block_count': 64, 'qwen3.context_length': 32768 })).toBe(64);
    expect(extractBlockCount({ 'llama.block_count': 80, 'general.parameter_count': 70e9 })).toBe(80);
  });
  it('returns null when absent / non-numeric / empty', () => {
    expect(extractBlockCount({ 'general.parameter_count': 7e9 })).toBeNull();
    expect(extractBlockCount({ 'x.block_count': 'eight' as any })).toBeNull();
    expect(extractBlockCount({})).toBeNull();
    expect(extractBlockCount(null)).toBeNull();
  });
});
