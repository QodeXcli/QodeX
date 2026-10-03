import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { pickWorkingCwd, formatHandoff, isUsableCwd } from '../src/session/handoff.js';

describe('pickWorkingCwd — session root wins over the host process', () => {
  const exists = (p: string) => p === '/work/app' || p === '/host' || p === '/handoff';

  it('prefers the durable session cwd over the bot launch directory', () => {
    expect(pickWorkingCwd({
      sessionCwd: '/work/app',
      hostCwd: '/host',
      exists,
    })).toBe(path.resolve('/work/app'));
  });

  it('falls back to the handoff cwd when the session has none', () => {
    expect(pickWorkingCwd({
      sessionCwd: null,
      handoffCwd: '/handoff',
      hostCwd: '/host',
      exists,
    })).toBe(path.resolve('/handoff'));
  });

  it('skips a candidate that no longer exists on disk', () => {
    expect(pickWorkingCwd({
      sessionCwd: '/deleted/project',
      handoffCwd: '/also-gone',
      hostCwd: '/host',
      exists,
    })).toBe(path.resolve('/host'));
  });

  it('never returns a relative path', () => {
    const abs = pickWorkingCwd({ sessionCwd: '/work/app', hostCwd: '/host', exists });
    expect(path.isAbsolute(abs)).toBe(true);
  });
});

describe('isUsableCwd', () => {
  it('accepts this process working directory', () => {
    expect(isUsableCwd(process.cwd())).toBe(true);
  });
  it('rejects a missing path', () => {
    expect(isUsableCwd('/no/such/qodex/project/xyz')).toBe(false);
  });
});

describe('formatHandoff still carries cwd', () => {
  it('shows the project path the bot must adopt', () => {
    const s = formatHandoff({
      sessionId: 'abcdefghijklmnop',
      cwd: '/work/app',
      updatedAt: new Date().toISOString(),
    });
    expect(s).toContain('/work/app');
    expect(s).toMatch(/abcdefgh/);
  });
});
