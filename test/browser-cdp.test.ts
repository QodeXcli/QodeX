import { describe, it, expect, afterEach } from 'vitest';
import { resolveBrowserCdpUrl, setBrowserCdpUrl } from '../src/tools/browser/session.js';

afterEach(() => setBrowserCdpUrl(undefined));

describe('resolveBrowserCdpUrl — attach precedence', () => {
  it('returns undefined by default (launch a fresh browser)', () => {
    expect(resolveBrowserCdpUrl({})).toBeUndefined();
  });
  it('uses the configured url (from config via setBrowserCdpUrl)', () => {
    setBrowserCdpUrl('http://127.0.0.1:9222');
    expect(resolveBrowserCdpUrl({})).toBe('http://127.0.0.1:9222');
  });
  it('QODEX_BROWSER_CDP_URL env OVERRIDES the configured url', () => {
    setBrowserCdpUrl('http://127.0.0.1:9222');
    expect(resolveBrowserCdpUrl({ QODEX_BROWSER_CDP_URL: 'http://127.0.0.1:9333' })).toBe('http://127.0.0.1:9333');
  });
  it('trims, and blank/whitespace resets to undefined', () => {
    setBrowserCdpUrl('  http://x:9222  ');
    expect(resolveBrowserCdpUrl({})).toBe('http://x:9222');
    setBrowserCdpUrl('   ');
    expect(resolveBrowserCdpUrl({})).toBeUndefined();
    expect(resolveBrowserCdpUrl({ QODEX_BROWSER_CDP_URL: '   ' })).toBeUndefined();
  });
});
