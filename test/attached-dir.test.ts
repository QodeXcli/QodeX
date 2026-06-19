import { describe, it, expect } from 'vitest';
import { extractAttachedDir } from '../src/agent/attached-dir.js';

describe('extractAttachedDir', () => {
  it('pulls the path from the attached-directory marker', () => {
    const prompt =
      'make it animated [Attached directory: /Users/you/Desktop/cctv_project/cctv_frontend] — treat this folder as the project/codebase to work on.';
    expect(extractAttachedDir(prompt)).toBe('/Users/you/Desktop/cctv_project/cctv_frontend');
  });

  it('handles the marker alone', () => {
    expect(extractAttachedDir('[Attached directory: /tmp/proj]')).toBe('/tmp/proj');
  });

  it('returns null when there is no marker', () => {
    expect(extractAttachedDir('just a normal prompt about /tmp/proj')).toBeNull();
    expect(extractAttachedDir('')).toBeNull();
  });

  it('trims surrounding whitespace in the path', () => {
    expect(extractAttachedDir('[Attached directory:   /a/b/c   ]')).toBe('/a/b/c');
  });
});
