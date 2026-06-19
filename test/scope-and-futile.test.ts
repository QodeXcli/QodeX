import { describe, it, expect } from 'vitest';
import { looksFutile, errorCodeOf } from '../src/agent/recovery.js';
import { userWantsExecution, isExecutionAction } from '../src/agent/scope-guard.js';

describe('looksFutile (soft-failure detection)', () => {
  it('flags exit-0-but-futile output that the model loops on', () => {
    for (const c of [
      '/bin/sh: node_modules/.bin/vite: No such file or directory',
      'Vite not found',
      '[ERROR] Unknown tool: run_dev_server',
      'Unknown option: network-timeout',
      '/bin/sh: timeout: command not found',
      'src/components/Header.jsx does not exist',
    ]) {
      expect(looksFutile(c)).toBe(true);
    }
  });

  it('does NOT flag genuine progress output', () => {
    for (const c of [
      '+ vite 5.4.21\n+ tailwindcss 3.4.19',
      '\u2713 215 modules transformed.\n\u2713 built in 1.88s',
      'Created src/components/layout/Header.tsx (403 lines)',
    ]) {
      expect(looksFutile(c)).toBe(false);
    }
  });

  it('futile content maps to a stable error code for loop counting', () => {
    expect(errorCodeOf('Vite not found')).toBe('FILE_NOT_FOUND');
  });
});

describe('scope-guard', () => {
  it('detects execution intent (EN + FA)', () => {
    expect(userWantsExecution('build it and run the tests')).toBe(true);
    expect(userWantsExecution('npm install then start the dev server')).toBe(true);
    expect(userWantsExecution('پروژه رو اجرا کن')).toBe(true);
    expect(userWantsExecution('نصب کن و تست بگیر')).toBe(true);
  });

  it('does NOT see execution intent in a pure design/edit request', () => {
    expect(userWantsExecution('لطفا کل دیزاین رو از اول طراحی کن')).toBe(false);
    expect(userWantsExecution('redesign the header with dark mode')).toBe(false);
  });

  it('flags dev-server / install tool calls as execution actions', () => {
    expect(isExecutionAction('dev_server_start', '')).toBe(true);
    expect(isExecutionAction('shell', 'cd /x && pnpm run dev')).toBe(true);
    expect(isExecutionAction('shell', 'pnpm add -D vite')).toBe(true);
    expect(isExecutionAction('shell', 'npm install')).toBe(true);
    expect(isExecutionAction('bash', 'npx vite')).toBe(true);
  });

  it('does NOT flag ordinary edit/read/inspect calls', () => {
    expect(isExecutionAction('write_file', 'src/x.tsx')).toBe(false);
    expect(isExecutionAction('read_file', 'package.json')).toBe(false);
    expect(isExecutionAction('shell', 'ls -la src/')).toBe(false);
    expect(isExecutionAction('shell', 'cat package.json')).toBe(false);
  });
});
