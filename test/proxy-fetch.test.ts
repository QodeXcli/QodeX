import { describe, it, expect, beforeEach } from 'vitest';
import { _resetProxyCacheForTesting, getDispatcherForUrl } from '../src/utils/proxy-fetch.js';

describe('getDispatcherForUrl', () => {
  beforeEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;
    delete process.env.no_proxy;
    _resetProxyCacheForTesting();
  });

  it('returns undefined when no proxy env is set', () => {
    expect(getDispatcherForUrl('https://example.com')).toBeUndefined();
  });

  it('returns a dispatcher for https when HTTPS_PROXY is set', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp:3128';
    _resetProxyCacheForTesting();
    const d = getDispatcherForUrl('https://example.com');
    expect(d).toBeDefined();
  });

  it('returns a dispatcher for http when HTTP_PROXY is set', () => {
    process.env.HTTP_PROXY = 'http://proxy.corp:3128';
    _resetProxyCacheForTesting();
    const d = getDispatcherForUrl('http://example.com');
    expect(d).toBeDefined();
  });

  it('accepts lowercase env vars', () => {
    process.env.https_proxy = 'http://proxy.corp:3128';
    _resetProxyCacheForTesting();
    expect(getDispatcherForUrl('https://example.com')).toBeDefined();
  });

  it('falls back to ALL_PROXY', () => {
    process.env.ALL_PROXY = 'http://proxy.corp:3128';
    _resetProxyCacheForTesting();
    expect(getDispatcherForUrl('https://anywhere.com')).toBeDefined();
    expect(getDispatcherForUrl('http://anywhere.com')).toBeDefined();
  });

  it('bypasses hosts listed in NO_PROXY (exact match)', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp:3128';
    process.env.NO_PROXY = 'internal.local';
    _resetProxyCacheForTesting();
    const proxied = getDispatcherForUrl('https://example.com');
    const bypassed = getDispatcherForUrl('https://internal.local');
    expect(proxied).toBeDefined();
    expect(bypassed).toBeDefined();
    expect(bypassed).not.toBe(proxied); // different dispatcher (no-proxy Agent vs ProxyAgent)
  });

  it('bypasses hosts matching a NO_PROXY suffix rule', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp:3128';
    process.env.NO_PROXY = '.corp.local, .internal';
    _resetProxyCacheForTesting();
    expect(getDispatcherForUrl('https://api.corp.local')).not.toBe(getDispatcherForUrl('https://api.example.com'));
    expect(getDispatcherForUrl('https://svc.internal')).not.toBe(getDispatcherForUrl('https://svc.example.com'));
  });

  it('bypasses everything on NO_PROXY="*"', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp:3128';
    process.env.NO_PROXY = '*';
    _resetProxyCacheForTesting();
    const a = getDispatcherForUrl('https://anywhere.com');
    const b = getDispatcherForUrl('https://other.com');
    // Both should hit the non-proxy dispatcher
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });

  it('returns undefined for invalid URLs', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp:3128';
    _resetProxyCacheForTesting();
    expect(getDispatcherForUrl('not a url')).toBeUndefined();
  });

  it('caches dispatchers across calls', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp:3128';
    _resetProxyCacheForTesting();
    const a = getDispatcherForUrl('https://example.com');
    const b = getDispatcherForUrl('https://other.com');
    expect(a).toBe(b); // same ProxyAgent for all https targets
  });
});
