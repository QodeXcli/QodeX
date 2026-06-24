import { describe, it, expect } from 'vitest';
import { canOpenBrowser, openUrl } from '../src/artifacts/open-browser.js';

describe('canOpenBrowser — gate auto-open to interactive, displayed sessions', () => {
  it('opens by default on macOS/Windows', () => {
    expect(canOpenBrowser({}, 'darwin')).toBe(true);
    expect(canOpenBrowser({}, 'win32')).toBe(true);
  });

  it('needs a display on Linux/BSD', () => {
    expect(canOpenBrowser({}, 'linux')).toBe(false);
    expect(canOpenBrowser({ DISPLAY: ':0' }, 'linux')).toBe(true);
    expect(canOpenBrowser({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true);
    expect(canOpenBrowser({}, 'freebsd')).toBe(false);
  });

  it('never opens under CI', () => {
    expect(canOpenBrowser({ CI: 'true' }, 'darwin')).toBe(false);
    expect(canOpenBrowser({ CI: '1', DISPLAY: ':0' }, 'linux')).toBe(false);
  });

  it('respects explicit opt-out env vars', () => {
    expect(canOpenBrowser({ QODEX_NO_BROWSER: '1' }, 'darwin')).toBe(false);
    expect(canOpenBrowser({ QODEX_NO_OPEN: '1' }, 'darwin')).toBe(false);
    expect(canOpenBrowser({ NO_BROWSER: '1' }, 'win32')).toBe(false);
  });
});

describe('openUrl — best-effort, never throws', () => {
  it('returns false (no spawn) when gated off, without throwing', async () => {
    await expect(openUrl('http://127.0.0.1:5000/', { env: { CI: '1' }, platform: 'darwin' })).resolves.toBe(false);
    await expect(openUrl('http://127.0.0.1:5000/', { env: {}, platform: 'linux' })).resolves.toBe(false);
  });
});
