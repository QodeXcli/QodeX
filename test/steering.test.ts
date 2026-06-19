import { describe, it, expect } from 'vitest';
import { parseSteerInput, buildSteerMessage } from '../src/agent/steering.js';

describe('parseSteerInput', () => {
  it('extracts the note after /btw', () => {
    expect(parseSteerInput('/btw also handle dark mode')).toBe('also handle dark mode');
  });
  it('trims surrounding whitespace', () => {
    expect(parseSteerInput('/btw   spaced note  ')).toBe('spaced note');
  });
  it('is case-insensitive', () => {
    expect(parseSteerInput('/BTW yell')).toBe('yell');
  });
  it('returns empty string for bare /btw', () => {
    expect(parseSteerInput('/btw')).toBe('');
  });
  it('returns null for a normal prompt', () => {
    expect(parseSteerInput('fix the header')).toBeNull();
  });
  it('does not match /btweird (word boundary)', () => {
    expect(parseSteerInput('/btweird stuff')).toBeNull();
  });
});

describe('buildSteerMessage', () => {
  it('frames the note as a mid-task steering message', () => {
    const m = buildSteerMessage('fix the header too');
    expect(m).toContain('STEERING NOTE');
    expect(m).toContain('fix the header too');
    expect(m).toContain('adjust course'); // tells the model it MAY change direction
    expect(m).toContain('Do not restart work'); // guards against redoing correct work
  });
  it('handles an empty note without crashing', () => {
    expect(buildSteerMessage('')).toContain('STEERING NOTE');
  });
});
