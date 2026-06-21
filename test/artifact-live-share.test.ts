import { describe, it, expect } from 'vitest';
import { checkLiveAuth } from '../src/artifacts/live-server.js';
import { parseTunnelUrl, lanUrls, makeAccessToken } from '../src/artifacts/live-share.js';

describe('checkLiveAuth — private-link token gate', () => {
  it('allows everything when no token is set (local mode)', () => {
    expect(checkLiveAuth(undefined, '/', undefined)).toEqual({ ok: true, setCookie: false });
  });
  it('accepts a matching ?k= and issues a cookie for follow-up requests', () => {
    expect(checkLiveAuth('abc', '/?k=abc', undefined)).toEqual({ ok: true, setCookie: true });
  });
  it('accepts the cookie on a request with no query (SSE / reload)', () => {
    expect(checkLiveAuth('abc', '/__live__', 'qx_live=abc')).toEqual({ ok: true, setCookie: false });
  });
  it('rejects a missing or wrong token', () => {
    expect(checkLiveAuth('abc', '/', undefined).ok).toBe(false);
    expect(checkLiveAuth('abc', '/?k=nope', undefined).ok).toBe(false);
    expect(checkLiveAuth('abc', '/', 'qx_live=nope').ok).toBe(false);
  });
  it('handles a URL-encoded token in the query', () => {
    expect(checkLiveAuth('a b', '/?k=a%20b', undefined)).toEqual({ ok: true, setCookie: true });
  });
});

describe('parseTunnelUrl', () => {
  it('extracts a cloudflared quick-tunnel URL from a log line', () => {
    const line = '2024-01-01 INF +-----+ |  https://brave-fox-123.trycloudflare.com  | +-----+';
    expect(parseTunnelUrl(line)).toBe('https://brave-fox-123.trycloudflare.com');
  });
  it('extracts an ngrok URL', () => {
    expect(parseTunnelUrl('url=https://abc-12-34.ngrok-free.app')).toBe('https://abc-12-34.ngrok-free.app');
  });
  it('returns undefined when no tunnel URL is present', () => {
    expect(parseTunnelUrl('starting tunnel, please wait...')).toBeUndefined();
  });
});

describe('lanUrls / makeAccessToken', () => {
  it('builds http LAN urls that carry the token', () => {
    const urls = lanUrls(5123, 'tok');
    for (const u of urls) {
      expect(u).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:5123\/\?k=tok$/);
    }
  });
  it('omits the token suffix when none is given', () => {
    for (const u of lanUrls(5123)) expect(u.endsWith(':5123/')).toBe(true);
  });
  it('makeAccessToken is non-empty, url-safe, and unique', () => {
    const a = makeAccessToken(), b = makeAccessToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(12);
    expect(a).not.toBe(b);
  });
});
