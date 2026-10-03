import { describe, it, expect } from 'vitest';
import { renderDashboard, DASHBOARD_STRINGS, DASHBOARD_INPUT_HELPERS } from '../src/control/dashboard.js';
import { describeControlCenter, type ControlCenterInfo } from '../src/control/server.js';
import { buildControlCommand, controlOptionsFromCli } from '../src/control/command.js';

function inlineScripts(html: string): { boot: string; code: string } {
  const boot = html.match(/<script id="qx-boot" type="application\/json">([\s\S]*?)<\/script>/);
  const code = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  return { boot: boot?.[1] ?? '', code: code?.[1] ?? '' };
}

describe('control dashboard HTML', () => {
  it('contains both languages and switches direction for Persian', () => {
    const en = renderDashboard({ lang: 'en' });
    expect(en).toContain('<html lang="en" dir="ltr">');
    expect(en).toContain('Take over');
    expect(en).toContain('Approvals');
    // Persian strings ship in the same page for the in-page toggle.
    expect(en).toContain('گرفتن کنترل');
    expect(en).toContain('تأییدها');
    expect(en).toContain('فارسی');

    const fa = renderDashboard({ lang: 'fa' });
    expect(fa).toContain('<html lang="fa" dir="rtl">');
    expect(fa).toContain('<title>مرکز کنترل QodeX</title>');
    expect(fa).toContain('گرفتن کنترل');
    expect(fa).toContain('Take over');
  });

  it('has every panel and talks only to its own API (no CDN)', () => {
    const html = renderDashboard();
    for (const id of ['livePanel', 'approvalsPanel', 'steerPanel', 'missionsPanel', 'activityPanel', 'takeBtn', 'url', 'frame', 'langBtn']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("new EventSource('/api/events')");
    expect(html).toContain("new EventSource('/api/frames')");
    expect(html).toContain("'/api/input'");
    expect(html).toContain("'/api/takeover'");
    expect(html).toContain("'/api/steer'");
    expect(html).toContain("'/api/approvals/'");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/\b(src|href)="https?:/i);
    // Missions panel starts hidden; it appears only when missions.list is registered.
    expect(html).toMatch(/id="missionsPanel" class="panel hidden"/);
  });

  it('never forwards input unless the human holds control', () => {
    const { code } = inlineScripts(renderDashboard());
    expect(code).toMatch(/function sendInput\(ev\) \{\s*if \(!state\.takeover\) return;/);
  });

  it('ships a syntactically valid inline script and boot JSON', () => {
    const { boot, code } = inlineScripts(renderDashboard({ lang: 'fa', title: 'My agent' }));
    expect(code.length).toBeGreaterThan(1000);
    // Parses (does not run) the browser script — catches template/escaping mistakes.
    expect(() => new Function(code)).not.toThrow();
    const parsed = JSON.parse(boot) as { lang: string; title: string; strings: typeof DASHBOARD_STRINGS };
    expect(parsed.lang).toBe('fa');
    expect(parsed.title).toBe('My agent');
    expect(parsed.strings.fa.takeOver).toBe('گرفتن کنترل');
  });

  it('escapes the title and keeps </script> out of the boot JSON', () => {
    const html = renderDashboard({ title: '</script><img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
    const { boot } = inlineScripts(html);
    expect(boot).not.toContain('</script>');
    expect((JSON.parse(boot) as { title: string }).title).toBe('</script><img src=x onerror=alert(1)>');
  });

  it('has the same keys in English and Persian, all non-empty', () => {
    const en = Object.keys(DASHBOARD_STRINGS.en).sort();
    const fa = Object.keys(DASHBOARD_STRINGS.fa).sort();
    expect(fa).toEqual(en);
    for (const k of en) {
      expect(DASHBOARD_STRINGS.en[k].trim()).not.toBe('');
      expect(DASHBOARD_STRINGS.fa[k].trim()).not.toBe('');
    }
    // Every data-i18n key used in the markup exists.
    const html = renderDashboard();
    for (const m of html.matchAll(/data-i18n(?:-ph|-title)?="([^"]+)"/g)) {
      expect(DASHBOARD_STRINGS.en).toHaveProperty(m[1]);
    }
  });
});

describe('describeControlCenter', () => {
  const info: ControlCenterInfo = {
    url: 'http://127.0.0.1:7420/?k=tok',
    port: 7420,
    token: 'tok',
    urls: ['http://127.0.0.1:7420/?k=tok', 'http://192.168.1.5:7420/?k=tok', 'https://x.trycloudflare.com/?k=tok'],
    tunnelUrl: 'https://x.trycloudflare.com/?k=tok',
    host: '0.0.0.0',
    lan: true,
    title: '',
    startedAt: 0,
    viewers: 0,
  };

  it('lists owner, LAN and public links with a privacy warning (EN + FA)', () => {
    const en = describeControlCenter(info);
    expect(en).toContain('Open:   http://127.0.0.1:7420/?k=tok');
    expect(en).toContain('LAN:    http://192.168.1.5:7420/?k=tok');
    expect(en).toContain('Public: https://x.trycloudflare.com/?k=tok');
    expect(en).toMatch(/Keep it private/);
    const fa = describeControlCenter({ ...info, tunnelUrl: undefined, urls: [info.url], tunnelError: 'cloudflared missing' }, 'fa');
    expect(fa).toContain('مرکز کنترل QodeX');
    expect(fa).toContain('cloudflared missing');
  });
});

describe('qodex control command', () => {
  it('builds a `control` command without short flags that clash with the root program', () => {
    const cmd = buildControlCommand();
    expect(cmd.name()).toBe('control');
    const flags = cmd.options.map(o => o.flags);
    expect(flags).toEqual(expect.arrayContaining(['--port <port>', '--lan', '--tunnel', '--host <host>', '--title <title>', '--lang <lang>']));
    // Root owns -p/--print, --json, -m, -y, -r, -c (commander parses them anywhere).
    for (const o of cmd.options) {
      expect(o.short).toBeUndefined();
      expect(['--json', '--print', '--model', '--yes', '--resume', '--continue']).not.toContain(o.long);
    }
  });

  it('validates CLI options', () => {
    expect(controlOptionsFromCli({ port: '8080', lan: true, tunnel: true, lang: 'FA', title: ' Ops ' }))
      .toEqual({ ok: true, options: { port: 8080, lan: true, tunnel: true, lang: 'fa', title: 'Ops' } });
    expect(controlOptionsFromCli({})).toEqual({ ok: true, options: {} });
    expect(controlOptionsFromCli({ port: 'abc' }).ok).toBe(false);
    expect(controlOptionsFromCli({ port: '70000' }).ok).toBe(false);
    expect(controlOptionsFromCli({ lang: 'de' }).ok).toBe(false);
    expect(controlOptionsFromCli({ host: 'a b' }).ok).toBe(false);
  });
});

// ── page-side input helpers (the same source string the page embeds) ─────────

type KeyAction = null | { kind: 'paste' } | { kind: 'text'; text: string } | { kind: 'key'; key: string };
interface Helpers {
  qxKeyAction: (e: Record<string, unknown>) => KeyAction;
  qxEnqueueInput: (q: Array<Record<string, unknown>>, ev: Record<string, unknown>, max?: number) => Array<Record<string, unknown>>;
}
const helpers = new Function(`${DASHBOARD_INPUT_HELPERS}\nreturn { qxKeyAction: qxKeyAction, qxEnqueueInput: qxEnqueueInput };`)() as Helpers;

function key(k: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const altGraph = !!extra.altGraph;
  return { key: k, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, getModifierState: (m: string) => m === 'AltGraph' && altGraph, ...extra };
}

describe('dashboard keyboard mapping', () => {
  it('embeds the helpers in the page script', () => {
    expect(renderDashboard({ lang: 'en' })).toContain('function qxKeyAction(e)');
  });

  it('types printable characters of any script (incl. emoji and ZWNJ) as text', () => {
    expect(helpers.qxKeyAction(key('a'))).toEqual({ kind: 'text', text: 'a' });
    expect(helpers.qxKeyAction(key('A', { shiftKey: true }))).toEqual({ kind: 'text', text: 'A' });
    expect(helpers.qxKeyAction(key('ش', { code: 'KeyA' }))).toEqual({ kind: 'text', text: 'ش' });
    expect(helpers.qxKeyAction(key('\u200c', { shiftKey: true, code: 'Space' }))).toEqual({ kind: 'text', text: '\u200c' });
    expect(helpers.qxKeyAction(key(' ', { code: 'Space' }))).toEqual({ kind: 'text', text: ' ' });
    // A surrogate pair is ONE character — Playwright's keyboard.press('😀') would throw.
    expect(helpers.qxKeyAction(key('😀'))).toEqual({ kind: 'text', text: '😀' });
  });

  it('types AltGr / macOS Option compositions instead of sending unknown key names', () => {
    // Windows AltGr reports ctrlKey+altKey; the AltGraph modifier state tells them apart.
    expect(helpers.qxKeyAction(key('@', { ctrlKey: true, altKey: true, altGraph: true, code: 'KeyQ' }))).toEqual({ kind: 'text', text: '@' });
    expect(helpers.qxKeyAction(key('™', { altKey: true, code: 'Digit2' }))).toEqual({ kind: 'text', text: '™' });
    expect(helpers.qxKeyAction(key('å', { altKey: true, code: 'KeyA' }))).toEqual({ kind: 'text', text: 'å' });
    // German Mac layout: Option+L is "@" (ASCII) — still typed, not "Alt+@".
    expect(helpers.qxKeyAction(key('@', { altKey: true, code: 'KeyL' }))).toEqual({ kind: 'text', text: '@' });
    // A plain Alt+letter is still a shortcut.
    expect(helpers.qxKeyAction(key('f', { altKey: true, code: 'KeyF' }))).toEqual({ kind: 'key', key: 'Alt+f' });
  });

  it('maps Ctrl/Cmd shortcuts on non-Latin layouts (Persian) to the physical key', () => {
    expect(helpers.qxKeyAction(key('ش', { ctrlKey: true, code: 'KeyA' }))).toEqual({ kind: 'key', key: 'ControlOrMeta+KeyA' });
    expect(helpers.qxKeyAction(key('ز', { metaKey: true, code: 'KeyC' }))).toEqual({ kind: 'key', key: 'ControlOrMeta+KeyC' });
    expect(helpers.qxKeyAction(key('۱', { ctrlKey: true, code: 'Digit1' }))).toEqual({ kind: 'key', key: 'ControlOrMeta+Digit1' });
    expect(helpers.qxKeyAction(key('ش', { ctrlKey: true, shiftKey: true, code: 'KeyA' }))).toEqual({ kind: 'key', key: 'ControlOrMeta+Shift+KeyA' });
    // Unknown physical key on a non-Latin layout → nothing (instead of a key Playwright rejects).
    expect(helpers.qxKeyAction(key('ش', { ctrlKey: true, code: '' }))).toBeNull();
    // Latin layouts keep readable names.
    expect(helpers.qxKeyAction(key('a', { ctrlKey: true, code: 'KeyA' }))).toEqual({ kind: 'key', key: 'ControlOrMeta+a' });
    expect(helpers.qxKeyAction(key('A', { ctrlKey: true, shiftKey: true, code: 'KeyA' }))).toEqual({ kind: 'key', key: 'ControlOrMeta+Shift+A' });
    expect(helpers.qxKeyAction(key(' ', { ctrlKey: true, code: 'Space' }))).toEqual({ kind: 'key', key: 'ControlOrMeta+Space' });
  });

  it('leaves Ctrl/Cmd+V to the native paste event on every layout', () => {
    expect(helpers.qxKeyAction(key('v', { ctrlKey: true, code: 'KeyV' }))).toEqual({ kind: 'paste' });
    expect(helpers.qxKeyAction(key('ر', { ctrlKey: true, code: 'KeyV' }))).toEqual({ kind: 'paste' });
    expect(helpers.qxKeyAction(key('v', { metaKey: true, code: 'KeyV' }))).toEqual({ kind: 'paste' });
  });

  it('sends named keys with their modifiers and ignores modifier-only / dead keys', () => {
    expect(helpers.qxKeyAction(key('Enter', { code: 'Enter' }))).toEqual({ kind: 'key', key: 'Enter' });
    expect(helpers.qxKeyAction(key('Tab', { shiftKey: true, code: 'Tab' }))).toEqual({ kind: 'key', key: 'Shift+Tab' });
    expect(helpers.qxKeyAction(key('ArrowLeft', { altKey: true, code: 'ArrowLeft' }))).toEqual({ kind: 'key', key: 'Alt+ArrowLeft' });
    for (const k of ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Dead', 'Unidentified', 'Process', '']) {
      expect(helpers.qxKeyAction(key(k))).toBeNull();
    }
    expect(helpers.qxKeyAction(key('a', { isComposing: true }))).toBeNull();
  });
});

describe('dashboard input queue', () => {
  const mv = (x: number) => ({ type: 'move', x, y: 1, frameWidth: 100, frameHeight: 100 });

  it('coalesces pointer moves so a slow link never builds a backlog', () => {
    const q: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 50; i++) helpers.qxEnqueueInput(q, mv(i));
    expect(q).toEqual([mv(49)]);
    helpers.qxEnqueueInput(q, { type: 'key', key: 'Enter' });
    helpers.qxEnqueueInput(q, mv(3));
    helpers.qxEnqueueInput(q, mv(4));
    expect(q).toEqual([mv(49), { type: 'key', key: 'Enter' }, mv(4)]);
  });

  it('drops a pending move right before a click (the click carries its own position)', () => {
    const q: Array<Record<string, unknown>> = [];
    helpers.qxEnqueueInput(q, mv(1));
    helpers.qxEnqueueInput(q, { type: 'click', x: 5, y: 5, frameWidth: 100, frameHeight: 100 });
    expect(q).toEqual([{ type: 'click', x: 5, y: 5, frameWidth: 100, frameHeight: 100 }]);
  });

  it('merges consecutive scrolls at the same point and consecutive typing', () => {
    const q: Array<Record<string, unknown>> = [];
    helpers.qxEnqueueInput(q, { type: 'scroll', dx: 0, dy: 100, x: 5, y: 5, frameWidth: 100, frameHeight: 100 });
    helpers.qxEnqueueInput(q, { type: 'scroll', dx: 10, dy: 50, x: 5, y: 5, frameWidth: 100, frameHeight: 100 });
    helpers.qxEnqueueInput(q, { type: 'type', text: 'سل' });
    helpers.qxEnqueueInput(q, { type: 'type', text: 'ام' });
    expect(q).toEqual([
      { type: 'scroll', dx: 10, dy: 150, x: 5, y: 5, frameWidth: 100, frameHeight: 100 },
      { type: 'type', text: 'سلام' },
    ]);
    // Scroll deltas stay inside the server's accepted range.
    for (let i = 0; i < 20; i++) helpers.qxEnqueueInput(q, { type: 'scroll', dx: 0, dy: 90_000 });
    const last = q[q.length - 1] as { dy: number };
    expect(last.dy).toBeLessThanOrEqual(100_000);
    // Typing merges only up to the server's 10000-character limit.
    const t: Array<Record<string, unknown>> = [];
    helpers.qxEnqueueInput(t, { type: 'type', text: 'a'.repeat(6000) });
    helpers.qxEnqueueInput(t, { type: 'type', text: 'b'.repeat(6000) });
    expect(t.map(e => (e.text as string).length)).toEqual([6000, 6000]);
  });

  it('is bounded: drops the oldest pointer move first, then the oldest event', () => {
    const q: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) helpers.qxEnqueueInput(q, { type: 'key', key: `F${i + 1}` }, 5);
    expect(q.map(e => e.key)).toEqual(['F6', 'F7', 'F8', 'F9', 'F10']);
    const q2: Array<Record<string, unknown>> = [];
    helpers.qxEnqueueInput(q2, { type: 'key', key: 'F1' }, 3);
    helpers.qxEnqueueInput(q2, mv(1), 3);
    helpers.qxEnqueueInput(q2, { type: 'key', key: 'F2' }, 3);
    helpers.qxEnqueueInput(q2, { type: 'key', key: 'F3' }, 3);
    expect(q2.map(e => e.type === 'move' ? 'move' : e.key)).toEqual(['F1', 'F2', 'F3']);
  });
});
