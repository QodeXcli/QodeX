import { describe, it, expect } from 'vitest';
import { detectErrorLoop, errorCodeOf } from '../src/agent/recovery.js';

describe('errorCodeOf', () => {
  it('reads a bracketed code', () => {
    expect(errorCodeOf('[FILE_NOT_FOUND] /x/Header.tsx does not exist.')).toBe('FILE_NOT_FOUND');
    expect(errorCodeOf('[ERROR] /x is a directory. Use ls.')).toBe('ERROR');
  });
  it('falls back to FILE_NOT_FOUND on phrasing', () => {
    expect(errorCodeOf('Header.tsx does not exist — did you mean Header.jsx')).toBe('FILE_NOT_FOUND');
  });
  it('defaults to ERROR', () => {
    expect(errorCodeOf('something went wrong')).toBe('ERROR');
  });
});

describe('detectErrorLoop', () => {
  it('fires on the wrong-filename guessing loop (same tool+code, different args)', () => {
    const re = [
      { name: 'read_file', code: 'FILE_NOT_FOUND' },
      { name: 'read_file', code: 'FILE_NOT_FOUND' },
      { name: 'read_file', code: 'FILE_NOT_FOUND' },
      { name: 'read_file', code: 'FILE_NOT_FOUND' },
    ];
    expect(detectErrorLoop(re)).toEqual({ name: 'read_file', code: 'FILE_NOT_FOUND', count: 4 });
  });

  it('does NOT fire on scattered/varied errors', () => {
    const re = [
      { name: 'read_file', code: 'FILE_NOT_FOUND' },
      { name: 'grep', code: 'ERROR' },
      { name: 'edit_symbol', code: 'ERROR' },
    ];
    expect(detectErrorLoop(re)).toBeNull();
  });

  it('does NOT fire below threshold', () => {
    expect(detectErrorLoop([{ name: 'read_file', code: 'FILE_NOT_FOUND' }])).toBeNull();
  });
});
