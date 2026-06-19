import { describe, it, expect, vi, afterEach } from 'vitest';

// We test the pure escaping behavior and the platform gate. The escaping
// function isn't exported, so we validate it indirectly: on a non-darwin
// platform notifyDesktop must be a no-op that resolves without spawning.

describe('notifyDesktop platform gate', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vi.restoreAllMocks();
  });

  it('is a no-op (resolves, never throws) off macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { notifyDesktop } = await import('../src/utils/notify.js');
    await expect(notifyDesktop({ title: 't', message: 'm' })).resolves.toBeUndefined();
  });
});

// Escaping is validated against the EXPORTED function the module actually uses,
// so the test can't drift from the implementation. This documents the security
// property: arbitrary task output can never break out of the AppleScript literal.
describe('AppleScript escaping contract', () => {
  it('escapes double quotes', async () => {
    const { escapeAppleScript: esc } = await import('../src/utils/notify.js');
    expect(esc('say "hi"')).toBe('say \\"hi\\"');
  });

  it('escapes backslashes', async () => {
    const { escapeAppleScript: esc } = await import('../src/utils/notify.js');
    expect(esc('a\\b')).toBe('a\\\\b');
  });

  it('collapses newlines to a single space', async () => {
    const { escapeAppleScript: esc } = await import('../src/utils/notify.js');
    expect(esc('line1\nline2')).toBe('line1 line2');
  });

  it('neutralizes an AppleScript injection attempt', async () => {
    const { escapeAppleScript: esc } = await import('../src/utils/notify.js');
    const evil = 'x" & (do shell script "rm -rf /") & "';
    const escaped = esc(evil);
    expect(escaped).not.toMatch(/[^\\]"/);
  });
});
