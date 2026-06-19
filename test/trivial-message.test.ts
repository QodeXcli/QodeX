import { describe, it, expect } from 'vitest';
import { isTrivialMessage } from '../src/agent/trivial-message.js';

describe('isTrivialMessage', () => {
  it('treats greetings / acks as trivial (skip retrieval)', () => {
    for (const g of ['Hi', 'hello', 'Hey!', 'thanks', 'ok', 'سلام', 'مرسی', 'ممنون', 'اوکی', 'چطوری', 'مرسی داداش']) {
      expect(isTrivialMessage(g)).toBe(true);
    }
    expect(isTrivialMessage('')).toBe(true);
  });

  it('treats real tasks as non-trivial (retrieval runs)', () => {
    for (const t of [
      'fix the login bug',
      'read src/App.jsx',
      'add breadcrumbs to /Users/x/proj',
      'why is this so slow?',
      'Hi, can you refactor the auth module for me please',
      'سلام، میشه این باگ رو درست کنی؟',
    ]) {
      expect(isTrivialMessage(t)).toBe(false);
    }
  });

  it('never misclassifies a short code-ish message as trivial', () => {
    expect(isTrivialMessage('ls()')).toBe(false);
    expect(isTrivialMessage('app.jsx')).toBe(false);
    expect(isTrivialMessage('[Attached directory: /x]')).toBe(false);
  });
});
