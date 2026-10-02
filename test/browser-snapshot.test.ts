import { describe, it, expect } from 'vitest';
import {
  filterInteractive,
  truncateSnapshot,
  truncateLongUrls,
  parseBoxes,
  stripBoxes,
  selectDrawableMarks,
  REF_RE,
} from '../src/tools/browser/snapshot.js';
import {
  normalizeUrl,
  normalizeKey,
  jpegSize,
  dedupFilename,
  isProfileLockedError,
  explainLaunchError,
  pushCapped,
} from '../src/tools/browser/session.js';

const SAMPLE = [
  '- generic [active] [ref=e1]:',
  '  - heading "Shop" [level=1] [ref=e2]',
  '  - navigation [ref=e3]:',
  '    - link "Home" [ref=e4] [cursor=pointer]:',
  '      - /url: /home',
  '  - generic [ref=e5]:',
  '    - generic [ref=e6]:',
  '      - text: Email',
  '      - textbox "Email" [ref=e7]',
  '    - text: Password',
  '    - textbox "Password" [ref=e8]',
  '    - combobox "Country" [ref=e9]:',
  '      - option "Iran" [selected]',
  '      - option "France"',
  '    - checkbox "Remember" [ref=e10]',
  '    - text: Remember',
  '    - button "Sign in" [ref=e11]',
  '  - paragraph [ref=e12]: Some paragraph text here that is long.',
  `  - link "Long link" [ref=e13] [cursor=pointer]:`,
  `    - /url: https://example.com/very/long/url/${'x'.repeat(200)}`,
  '  - iframe [ref=e14]:',
  '    - button "Inner" [ref=f1e2]',
  '  - generic [ref=e15] [cursor=pointer]: Clicky div',
  '  - link [ref=e16] [cursor=pointer]:',
  '    - img "Company logo" [ref=e17] [cursor=pointer]',
  '  - alert [ref=e18]: Wrong password',
].join('\n');

describe('filterInteractive', () => {
  const out = filterInteractive(SAMPLE);

  it('keeps headings and interactive refs, drops containers and plain text', () => {
    expect(out).toContain('- heading "Shop" [level=1] [ref=e2]');
    expect(out).toContain('- textbox "Email" [ref=e7]');
    expect(out).toContain('- textbox "Password" [ref=e8]');
    expect(out).toContain('- checkbox "Remember" [ref=e10]');
    expect(out).toContain('- button "Sign in" [ref=e11]');
    expect(out).toContain('- button "Inner" [ref=f1e2]');
    expect(out).not.toContain('paragraph');
    expect(out).not.toContain('navigation');
    expect(out).not.toMatch(/text: Email/);
    expect(out).not.toContain('[ref=e1]');
  });

  it('keeps link URLs as children, truncating long ones to 120 chars', () => {
    expect(out).toMatch(/- link "Home" \[ref=e4\] \[cursor=pointer\]\n {2}- \/url: \/home/);
    const longLine = out.split('\n').find(l => l.includes('/url: https://example.com'))!;
    expect(longLine).toBeDefined();
    const url = longLine.replace(/^\s*- \/url: /, '');
    expect(url.length).toBe(121); // 120 + ellipsis
    expect(url.endsWith('…')).toBe(true);
  });

  it('keeps options of a kept combobox (needed to choose a value)', () => {
    expect(out).toMatch(/- combobox "Country" \[ref=e9\]\n {2}- option "Iran" \[selected\]\n {2}- option "France"/);
  });

  it('keeps pointer-cursor click targets not nested in a kept element, and alerts', () => {
    expect(out).toContain('- generic [ref=e15] [cursor=pointer]: Clicky div');
    expect(out).not.toContain('[ref=e17]'); // img inside a kept link
    expect(out).toContain('- alert [ref=e18]: Wrong password');
  });

  it('borrows a descendant name for unnamed links', () => {
    expect(out).toContain('- link [ref=e16] [cursor=pointer] (text: Company logo)');
  });

  it('caps long option lists', () => {
    const many = ['- combobox "City" [ref=e1]:', ...Array.from({ length: 40 }, (_, i) => `  - option "City ${i}"`)].join('\n');
    const f = filterInteractive(many, { maxOptions: 5 });
    expect(f.split('\n').filter(l => l.includes('option "')).length).toBe(5);
    expect(f).toContain('… 35 more option(s)');
  });

  it('returns empty for a page with nothing actionable', () => {
    expect(filterInteractive('- generic [ref=e1]:\n  - paragraph [ref=e2]: hi')).toBe('');
  });
});

describe('truncateSnapshot / truncateLongUrls', () => {
  it('leaves short text alone', () => {
    expect(truncateSnapshot('a\nb', 100)).toEqual({ text: 'a\nb', truncated: false, omittedLines: 0 });
  });

  it('cuts at a line boundary and says how to see more', () => {
    const text = Array.from({ length: 200 }, (_, i) => `- button "Button number ${i}" [ref=e${i}]`).join('\n');
    const r = truncateSnapshot(text, 1000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(1000);
    expect(r.text).toMatch(/… \[\d+ more lines — use selector=\.\.\. or browser_extract\]$/);
    const kept = r.text.split('\n').slice(0, -1);
    for (const l of kept) expect(l).toMatch(/^- button "Button number \d+" \[ref=e\d+\]$/);
    expect(kept.length + r.omittedLines).toBe(200);
  });

  it('shortens huge /url: lines in full snapshots', () => {
    const t = truncateLongUrls(`- link "x" [ref=e1]:\n  - /url: data:image/png;base64,${'A'.repeat(5000)}`, 300);
    expect(t.length).toBeLessThan(400);
  });
});

describe('set-of-marks boxes', () => {
  const BOXES = [
    '- generic [active] [ref=e1] [box=8,8,984,684]:',
    '  - button "Sign in" [ref=e11] [box=652,85,57,21]',
    '  - iframe [ref=e14] [box=75,156,304,154]:',
    '    - button "Inner" [ref=f1e2] [box=8,8,46,21]',
    '  - generic [ref=e15] [cursor=pointer] [box=8,314,984,18]: Clicky div',
    '  - button "Far below" [ref=e20] [box=8,2000,50,20]',
  ].join('\n');

  it('parses boxes and offsets iframe children by the frame position', () => {
    const marks = parseBoxes(BOXES);
    const inner = marks.find(m => m.ref === 'f1e2')!;
    expect(inner).toMatchObject({ role: 'button', name: 'Inner', x: 83, y: 164, w: 46, h: 21 });
    expect(marks.find(m => m.ref === 'e11')).toMatchObject({ x: 652, y: 85, name: 'Sign in' });
    expect(marks.find(m => m.ref === 'e15')?.pointer).toBe(true);
  });

  it('only draws interactive / clickable marks inside the viewport', () => {
    const drawable = selectDrawableMarks(parseBoxes(BOXES), { width: 1000, height: 700 }).map(m => m.ref);
    expect(drawable).toEqual(['e11', 'f1e2', 'e15']);
  });

  it('stripBoxes removes box annotations', () => {
    expect(stripBoxes(BOXES)).not.toContain('[box=');
    expect(stripBoxes(BOXES)).toContain('- button "Sign in" [ref=e11]');
  });
});

describe('ref / url / key helpers', () => {
  it('REF_RE accepts page and iframe refs only', () => {
    for (const ok of ['e1', 'e123', 'f1e2', 'f12e345']) expect(REF_RE.test(ok)).toBe(true);
    for (const bad of ['E1', 'ref=e1', '#e1', 'button', 'e', 'f1', '12']) expect(REF_RE.test(bad)).toBe(false);
  });

  it('normalizeUrl adds a scheme to bare domains and local addresses', () => {
    expect(normalizeUrl('digikala.com')).toBe('https://digikala.com');
    expect(normalizeUrl('www.example.org/path?q=1')).toBe('https://www.example.org/path?q=1');
    expect(normalizeUrl('localhost:3000/app')).toBe('http://localhost:3000/app');
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeUrl('192.168.1.10')).toBe('http://192.168.1.10');
    expect(normalizeUrl('https://x.io')).toBe('https://x.io');
    expect(normalizeUrl('about:blank')).toBe('about:blank');
    expect(normalizeUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html');
    expect(normalizeUrl('//cdn.example.com/a.js')).toBe('https://cdn.example.com/a.js');
    expect(normalizeUrl('دیجی‌کالا.com')).toBe('https://دیجی‌کالا.com');
    expect(normalizeUrl('not a url')).toBe('not a url');
  });

  it('normalizeKey maps common names to Playwright keys', () => {
    expect(normalizeKey('enter')).toBe('Enter');
    expect(normalizeKey('esc')).toBe('Escape');
    expect(normalizeKey('ctrl+a')).toBe('Control+a');
    expect(normalizeKey('cmd+shift+t')).toBe('Meta+Shift+t');
    expect(normalizeKey('pgdn')).toBe('PageDown');
    expect(normalizeKey('down')).toBe('ArrowDown');
    expect(normalizeKey('f5')).toBe('F5');
    expect(normalizeKey('Control++')).toBe('Control++');
    expect(normalizeKey('a')).toBe('a');
  });

  it('jpegSize reads dimensions from the SOF segment', () => {
    // SOI, APP0 (len 16), SOF0 (h=480, w=640), EOI
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, ...new Array(9).fill(0)];
    const buf = Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
    expect(jpegSize(buf.toString('base64'))).toEqual({ width: 640, height: 480 });
    expect(jpegSize(Buffer.from('not a jpeg').toString('base64'))).toBeNull();
  });

  it('dedupFilename sanitizes and avoids collisions', () => {
    const taken = new Set(['report.pdf', 'report (1).pdf']);
    expect(dedupFilename('report.pdf', n => taken.has(n))).toBe('report (2).pdf');
    expect(dedupFilename('../../etc/passwd', () => false)).toBe('_.._etc_passwd');
    expect(dedupFilename('', () => false)).toBe('download');
    expect(dedupFilename('a:b?.txt', () => false)).toBe('a_b_.txt');
  });

  it('pushCapped keeps the newest entries', () => {
    const a: number[] = [];
    for (let i = 0; i < 10; i++) pushCapped(a, i, 3);
    expect(a).toEqual([7, 8, 9]);
  });
});

describe('launch error explanations', () => {
  it('detects a profile locked by another Chromium', () => {
    expect(isProfileLockedError(new Error('browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory.'))).toBe(true);
    expect(isProfileLockedError(new Error('The profile appears to be in use by another Chromium process'))).toBe(true);
    expect(isProfileLockedError(new Error('Timeout 30000ms exceeded'))).toBe(false);
  });

  it('explains a missing executable with concrete fixes', () => {
    const e = explainLaunchError(new Error("browserType.launchPersistentContext: Executable doesn't exist at /x/chromium-1228/chrome"), { source: 'none' });
    expect(e.message).toMatch(/^\[BROWSER_LAUNCH_FAILED\]/);
    expect(e.message).toContain('QODEX_BROWSER_EXECUTABLE');
    expect(e.message).toContain('browser.executablePath');
    expect(e.message).toContain('npx playwright install chromium');
  });

  it('explains a missing display for headed mode', () => {
    const e = explainLaunchError(new Error('Looks like you launched a headed browser without having a XServer running. Missing X server or $DISPLAY'), { executablePath: '/c', source: 'system' });
    expect(e.message).toMatch(/needs a display/);
  });
});
