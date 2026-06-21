import { describe, it, expect, vi } from 'vitest';
import {
  injectLiveReload,
  renderErrorOverlay,
  liveReloadClientScript,
  LIVE_CHANNEL_PATH,
} from '../src/artifacts/live-reload.js';
import { hashHtml, shouldPush, makeDebouncer } from '../src/artifacts/live-server.js';

describe('live-reload client injection', () => {
  it('inserts the snippet just before </body> when present', () => {
    const out = injectLiveReload('<html><body><h1>hi</h1></body></html>');
    expect(out.indexOf('EventSource')).toBeGreaterThan(out.indexOf('<h1>hi</h1>'));
    expect(out.indexOf('EventSource')).toBeLessThan(out.indexOf('</body>'));
    // exactly one body close, snippet sits inside it
    expect(out).toMatch(/<script>.*EventSource.*<\/script><\/body>/s);
  });

  it('appends the snippet when there is no </body> (fragment artifact)', () => {
    const out = injectLiveReload('<div>just a fragment</div>');
    expect(out.startsWith('<div>just a fragment</div>')).toBe(true);
    expect(out).toContain('EventSource');
  });

  it('references the given channel path and reload behavior', () => {
    const s = liveReloadClientScript('/__custom__');
    expect(s).toContain('new EventSource("/__custom__")');
    expect(s).toContain("addEventListener('reload'");
    expect(s).toContain('location.reload()');
  });

  it('defaults the channel to LIVE_CHANNEL_PATH', () => {
    expect(liveReloadClientScript()).toContain(`new EventSource(${JSON.stringify(LIVE_CHANNEL_PATH)})`);
  });

  it('error overlay is a full doc, escapes the message, and self-recovers via the client', () => {
    const html = renderErrorOverlay('boom <script>alert(1)</script> & co');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('&lt;script&gt;');     // message HTML-escaped
    expect(html).not.toContain('<script>alert(1)</script>'); // not injected raw
    expect(html).toContain('EventSource');        // carries the live-reload client
  });
});

describe('live-server pure helpers', () => {
  it('hashHtml is stable and content-sensitive', () => {
    expect(hashHtml('a')).toBe(hashHtml('a'));
    expect(hashHtml('a')).not.toBe(hashHtml('b'));
  });

  it('shouldPush only when the hash changed', () => {
    expect(shouldPush(null, 'x')).toBe(true);
    expect(shouldPush('x', 'x')).toBe(false);
    expect(shouldPush('x', 'y')).toBe(true);
  });

  it('makeDebouncer collapses rapid calls into one trailing invocation', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = makeDebouncer(fn, 100);
      d(); d(); d();
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(99);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debouncer.cancel prevents a pending invocation', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = makeDebouncer(fn, 100);
      d();
      d.cancel();
      vi.advanceTimersByTime(200);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
