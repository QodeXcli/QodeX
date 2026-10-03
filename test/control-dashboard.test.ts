import { describe, it, expect } from 'vitest';
import { renderDashboard, DASHBOARD_STRINGS } from '../src/control/dashboard.js';
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
