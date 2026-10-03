/**
 * H1 — browser-side CAPTCHA hand-off: pure / fake-manager tests (no browser).
 * Real-Chromium coverage lives in test/handoff-browser-real.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyChallenge, challengeFrameVendor, isChallengeFrameUrl, isChallengeElement, pickChallengeHeaders,
  stripQuery, waitForChallengeChange, challengeHint, CHALLENGE_PROBE_FN, FRAME_BOX_FN,
  type ChallengeMarkers, type ChallengeInfo,
} from '../src/tools/browser/challenge.js';
import { DESCRIBE_ELEMENT_JS } from '../src/tools/browser/snapshot.js';
import { WorkflowRecorder } from '../src/workflows/recorder.js';
import { BrowserEvaluateTool, BrowserWaitForTool, CHALLENGE_SCRIPT_RE } from '../src/tools/browser/tools.js';
import { setBrowserManagerForTests } from '../src/tools/browser/types.js';
import { FakeManager } from './workflows-fakes.js';
import * as os from 'os';
import * as path from 'path';
import { QodexBrowserManager } from '../src/tools/browser/session.js';
import { BROWSER_TOOL_CLASSES } from '../src/tools/browser/index.js';
import { BrowserRequestHumanTool, cleanReason, handoffPrompt, runHandoff, formatDuration, HANDOFF_OPTIONS } from '../src/tools/browser/handoff.js';
import { formatChallengeLine } from '../src/tools/browser/tools.js';
import { classifyAction, isGuardedTool } from '../src/sentinel/policy.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';
import { selectRelevantToolNames } from '../src/agent/tool-relevance.js';
import { normalizeAnswer, safeOption } from '../src/control/approvals.js';

describe('recorder never records challenge steps', () => {
  it('skips steps on challenge elements and every human step during a hand-off', async () => {
    const mgr = new FakeManager();
    mgr.page.currentUrl = 'https://shop.example/login';
    const rec = new WorkflowRecorder();
    try {
      await rec.start({ name: 'login', mgr, source: 'mixed' });
      const url = mgr.activeUrl();
      mgr.recordAction({ tool: 'browser_fill', args: { selector: '#user', value: 'me' }, url, actor: 'agent', element: { selector: '#user', role: 'textbox', name: 'User', tag: 'input' } });
      mgr.recordAction({ tool: 'browser_click', args: { x: 10, y: 10 }, url, actor: 'human', element: { selector: 'div', role: 'checkbox', name: "I'm not a robot", challenge: true } });
      mgr.recordAction({ tool: 'browser_click', args: { x: 20, y: 20 }, url, actor: 'human', element: { selector: '#px-captcha', role: 'button', name: 'Press & Hold' } });
      const status = mgr.status.bind(mgr);
      (mgr as any).status = () => ({ ...status(), takeover: true, takeoverBy: 'handoff:abc' });
      mgr.recordAction({ tool: 'browser_type', args: { text: '123456' }, url, actor: 'human', element: { selector: '#code', role: 'textbox', name: 'Code' } });
      (mgr as any).status = status;
      mgr.recordAction({ tool: 'browser_click', args: { selector: '#go' }, url, actor: 'human', element: { selector: '#go', role: 'button', name: 'Continue' } });
      const wf = await rec.stop();
      expect(wf.steps.map(s => `${s.kind}:${s.selector ?? s.url ?? ''}`)).toEqual(['navigate:https://shop.example/login', 'fill:#user', 'click:#go']);
      expect(rec.status().warnings.join(' ')).toMatch(/CAPTCHA \/ bot check/);
    } finally {
      await rec.discard();
    }
  });
});

describe('page scripts may not reach into a CAPTCHA', () => {
  it('browser_evaluate / wait_for function refuse widget- or token-touching scripts before running', async () => {
    const mgr = new FakeManager();
    setBrowserManagerForTests(mgr);
    try {
      const ctx: any = { cwd: '/tmp', signal: new AbortController().signal, emit: () => {}, askUser: async () => 'yes' };
      const r = await new BrowserEvaluateTool().execute({ script: "return document.querySelector('[name=g-recaptcha-response]').value" }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\]/);
      const w = await new BrowserWaitForTool().execute({ kind: 'function', value: "document.querySelector('.cf-turnstile input').value.length > 0" }, ctx);
      expect(w.content).toMatch(/^\[CHALLENGE_HUMAN_ONLY\]/);
      expect(mgr.page.log).toEqual([]);
      expect(CHALLENGE_SCRIPT_RE.test('return document.title')).toBe(false);
    } finally {
      setBrowserManagerForTests(null);
    }
  });
});

function markers(over: Partial<ChallengeMarkers> = {}): ChallengeMarkers {
  return {
    bodyTextLen: 1200, recaptcha: false, recaptchaResponseLen: 0, recaptchaBadge: false, hcaptcha: false, hcaptchaResponseLen: 0,
    turnstile: false, turnstileResponseLen: 0, cfInterstitial: false, cfBlocked: false, checkingText: false,
    akamaiInterstitial: false, accessDeniedRef: false, perimeterx: false, datadome: false, awsCaptcha: false, arkose: false,
    geetest: false, friendly: false, altcha: false, yandex: false, imperva: false, impervaBlocked: false,
    sucuriChallenge: false, sucuriBlocked: false, ddosGuard: false, ddosGuardCaptcha: false, genericCaptcha: false, box: null,
    ...over,
  };
}

const ANCHOR = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc_SITEKEY_secret&co=aHR0cHM&hl=en&v=abc&size=normal&cb=xyz';
const BFRAME = 'https://www.google.com/recaptcha/api2/bframe?hl=en&v=abc&k=6Lc_SITEKEY_secret';
const BADGE = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc_SITEKEY&co=x&hl=en&v=abc&size=invisible&cb=1';
const TURNSTILE = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/0x4AAA/light/normal';

describe('challengeFrameVendor / isChallengeFrameUrl', () => {
  it('recognises vendor frames by host or path signature', () => {
    expect(challengeFrameVendor(ANCHOR)).toEqual({ vendor: 'recaptcha', kind: 'anchor' });
    expect(challengeFrameVendor(BFRAME)).toEqual({ vendor: 'recaptcha', kind: 'bframe' });
    expect(challengeFrameVendor(BADGE)).toEqual({ vendor: 'recaptcha', kind: 'invisible' });
    expect(challengeFrameVendor('https://www.recaptcha.net/recaptcha/enterprise/anchor?k=x')?.vendor).toBe('recaptcha');
    expect(challengeFrameVendor('https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=1')).toEqual({ vendor: 'hcaptcha', kind: 'checkbox' });
    expect(challengeFrameVendor('https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge&id=1')).toEqual({ vendor: 'hcaptcha', kind: 'challenge' });
    expect(challengeFrameVendor(TURNSTILE)?.vendor).toBe('turnstile');
    expect(challengeFrameVendor('https://geo.captcha-delivery.com/captcha/?initialCid=x&t=fe&cid=y')).toEqual({ vendor: 'datadome', kind: 'captcha' });
    expect(challengeFrameVendor('https://geo.captcha-delivery.com/captcha/?initialCid=x&t=bv&cid=y')).toEqual({ vendor: 'datadome', kind: 'block' });
    expect(challengeFrameVendor('https://geo.captcha-delivery.com/interstitial/?x=1')).toEqual({ vendor: 'datadome', kind: 'interstitial' });
    expect(challengeFrameVendor('https://client-api.arkoselabs.com/fc/gc/?token=abc')?.vendor).toBe('arkose');
    expect(challengeFrameVendor('https://tenant-api.arkoselabs.com/v2/1.5.5/enforcement.html')?.vendor).toBe('arkose');
    expect(challengeFrameVendor('https://shop.example/_sec/cp_challenge/ak-challenge-3-6.htm')?.vendor).toBe('akamai');
    expect(challengeFrameVendor('https://smartcaptcha.yandexcloud.net/checkbox?sitekey=x')?.vendor).toBe('yandex');
    // A local stand-in served on another port is still recognised by its path.
    expect(isChallengeFrameUrl('http://127.0.0.1:5555/recaptcha/api2/anchor?k=x')).toBe(true);
    expect(isChallengeFrameUrl('http://127.0.0.1:5555/cdn-cgi/challenge-platform/h/b/turnstile/if/x')).toBe(true);
  });

  it('ignores ordinary frames (ads, embeds, YouTube, maps)', () => {
    for (const u of ['https://www.youtube.com/embed/xyz', 'https://maps.google.com/maps?q=1', 'https://ads.example/frame', 'about:blank', '', 'https://shop.example/cdn-cgi/scripts/jsd/main.js']) {
      expect(isChallengeFrameUrl(u), u).toBe(false);
    }
  });

  it('stripQuery keeps origin + path only', () => {
    expect(stripQuery(ANCHOR)).toBe('https://www.google.com/recaptcha/api2/anchor');
    expect(stripQuery('https://x.example/a?__cf_chl_rt_tk=SECRET#f')).toBe('https://x.example/a');
  });
});

describe('classifyChallenge (pure)', () => {
  const page = 'https://shop.example/login?next=%2Fcart&__cf_chl_tk=TOKEN123';

  it('a visible reCAPTCHA checkbox needs a human; no query string reaches the result', () => {
    const r = classifyChallenge({ mainUrl: page, title: 'Login', frames: [{ url: ANCHOR, visible: true, w: 304, h: 78, x: 10, y: 200 }], domMarkers: markers({ recaptcha: true }) });
    expect(r).toMatchObject({ vendor: 'recaptcha', state: 'needs-human', host: 'shop.example', frameUrl: 'https://www.google.com/recaptcha/api2/anchor', frameBox: { x: 10, y: 200, w: 304, h: 78 } });
    expect(JSON.stringify(r)).not.toMatch(/SITEKEY|TOKEN123|__cf_chl|next=/);
    expect(r!.hint).toContain('browser_request_human');
  });

  it('a solved reCAPTCHA (response field filled) is not a challenge', () => {
    expect(classifyChallenge({ mainUrl: page, title: 'Login', frames: [{ url: ANCHOR, visible: true, w: 304, h: 78 }], domMarkers: markers({ recaptcha: true, recaptchaResponseLen: 500 }) })).toBeNull();
  });

  it('the reCAPTCHA v3 badge / invisible anchor is NOT a challenge', () => {
    expect(classifyChallenge({ mainUrl: page, title: 'Home', frames: [{ url: BADGE, visible: true, w: 256, h: 60, badge: true }], domMarkers: markers({ recaptchaBadge: true }) })).toBeNull();
    // even if the badge flag was missed, size=invisible marks the anchor as invisible
    expect(classifyChallenge({ mainUrl: page, title: 'Home', frames: [{ url: BADGE, visible: true, w: 256, h: 60 }], domMarkers: markers() })).toBeNull();
    // an anchor inside the badge container (no size=invisible) is skipped too
    expect(classifyChallenge({ mainUrl: page, title: 'Home', frames: [{ url: ANCHOR, visible: true, w: 256, h: 60, badge: true }], domMarkers: markers() })).toBeNull();
  });

  it('a hidden (parked off-screen) bframe is not a challenge; a shown one is', () => {
    expect(classifyChallenge({ mainUrl: page, title: 'x', frames: [{ url: BFRAME, visible: false, w: 400, h: 580 }], domMarkers: markers() })).toBeNull();
    expect(classifyChallenge({ mainUrl: page, title: 'x', frames: [{ url: BFRAME, visible: true, w: 400, h: 580 }], domMarkers: markers() })).toMatchObject({ vendor: 'recaptcha', state: 'needs-human' });
  });

  it('Cloudflare interstitial clears by itself; its block page is blocked', () => {
    expect(classifyChallenge({ mainUrl: page, title: 'Just a moment...', frames: [], domMarkers: markers({ cfInterstitial: true, bodyTextLen: 120 }) }))
      .toMatchObject({ vendor: 'cloudflare', state: 'self-clearing' });
    expect(classifyChallenge({ mainUrl: page, title: 'Just a moment...', frames: [{ url: TURNSTILE, visible: true, w: 300, h: 65 }], domMarkers: markers({ cfInterstitial: true }) }))
      .toMatchObject({ vendor: 'cloudflare', state: 'self-clearing' });
    expect(classifyChallenge({ mainUrl: page, title: 'Attention Required! | Cloudflare', frames: [], domMarkers: markers({ cfBlocked: true }) }))
      .toMatchObject({ vendor: 'cloudflare', state: 'blocked' });
  });

  it('a standalone Turnstile widget is self-clearing until solved', () => {
    expect(classifyChallenge({ mainUrl: page, title: 'Sign up', frames: [{ url: TURNSTILE, visible: true, w: 300, h: 65 }], domMarkers: markers({ turnstile: true }) }))
      .toMatchObject({ vendor: 'turnstile', state: 'self-clearing' });
    expect(classifyChallenge({ mainUrl: page, title: 'Sign up', frames: [{ url: TURNSTILE, visible: true, w: 300, h: 65 }], domMarkers: markers({ turnstile: true, turnstileResponseLen: 900 }) })).toBeNull();
  });

  it('headers count only while the in-page probe is unavailable (stale after an in-place swap)', () => {
    const headers = { 'cf-mitigated': 'challenge', server: 'cloudflare' };
    expect(classifyChallenge({ mainUrl: page, title: '', status: 403, headers, frames: [], domMarkers: null })).toMatchObject({ vendor: 'cloudflare', state: 'self-clearing' });
    expect(classifyChallenge({ mainUrl: page, title: 'Welcome', status: 403, headers, frames: [], domMarkers: markers() })).toBeNull();
    expect(classifyChallenge({ mainUrl: page, title: '', status: 405, headers: { 'x-amzn-waf-action': 'captcha' }, frames: [], domMarkers: null })).toMatchObject({ vendor: 'aws-waf', state: 'needs-human' });
    expect(classifyChallenge({ mainUrl: page, title: '', status: 202, headers: { 'x-amzn-waf-action': 'challenge' }, frames: [], domMarkers: null })).toMatchObject({ vendor: 'aws-waf', state: 'self-clearing' });
  });

  it('in-page challenges: PerimeterX, GeeTest, Akamai, DataDome, generic image CAPTCHA', () => {
    expect(classifyChallenge({ mainUrl: page, title: 'Access to this page has been denied', frames: [], domMarkers: markers({ perimeterx: true, box: { x: 1, y: 2, w: 300, h: 100 } }) }))
      .toMatchObject({ vendor: 'perimeterx', state: 'needs-human', frameBox: { x: 1, y: 2, w: 300, h: 100 } });
    expect(classifyChallenge({ mainUrl: page, title: 'x', frames: [], domMarkers: markers({ geetest: true }) })).toMatchObject({ vendor: 'geetest', state: 'needs-human' });
    expect(classifyChallenge({ mainUrl: page, title: 'x', frames: [], domMarkers: markers({ akamaiInterstitial: true }) })).toMatchObject({ vendor: 'akamai', state: 'self-clearing' });
    expect(classifyChallenge({ mainUrl: page, title: 'Access Denied', headers: { server: 'AkamaiGHost' }, frames: [], domMarkers: markers({ accessDeniedRef: true }) })).toMatchObject({ vendor: 'akamai', state: 'blocked' });
    expect(classifyChallenge({ mainUrl: page, title: 'x', frames: [{ url: 'https://geo.captcha-delivery.com/captcha/?t=fe', visible: true, w: 400, h: 500 }], domMarkers: markers({ datadome: true }) })).toMatchObject({ vendor: 'datadome', state: 'needs-human' });
    expect(classifyChallenge({ mainUrl: page, title: 'x', frames: [{ url: 'https://geo.captcha-delivery.com/captcha/?t=bv', visible: true, w: 400, h: 500 }], domMarkers: markers() })).toMatchObject({ vendor: 'datadome', state: 'blocked' });
    expect(classifyChallenge({ mainUrl: page, title: 'Register', frames: [], domMarkers: markers({ genericCaptcha: true }) })).toMatchObject({ vendor: 'captcha', state: 'needs-human' });
    expect(classifyChallenge({ mainUrl: 'https://www.google.com/sorry/index?continue=x', title: 'Sorry', frames: [], domMarkers: markers() })).toMatchObject({ vendor: 'recaptcha', state: 'needs-human' });
  });

  it('a normal page is not a challenge (incl. Cloudflare jsd script and "just a moment" prose)', () => {
    expect(classifyChallenge({ mainUrl: page, title: 'Shop', frames: [], domMarkers: markers({ checkingText: true, bodyTextLen: 50_000 }) })).toBeNull();
    expect(classifyChallenge({ mainUrl: page, title: 'Shop', status: 200, headers: { server: 'cloudflare', 'cf-ray': '1' }, frames: [], domMarkers: markers() })).toBeNull();
    expect(classifyChallenge({ mainUrl: page, title: 'Shop', frames: [{ url: 'https://www.youtube.com/embed/x', visible: true, w: 600, h: 400 }], domMarkers: markers() })).toBeNull();
  });

  it('the hint never names the URL path or query, and adapts to report mode / blocked', () => {
    const h = challengeHint('recaptcha', 'needs-human', 'shop.example');
    expect(h).toContain('reCAPTCHA on shop.example needs a human');
    expect(h).toContain('browser_request_human');
    expect(challengeHint('recaptcha', 'needs-human', 'shop.example', 'report')).not.toContain('browser_request_human');
    expect(challengeHint('cloudflare', 'blocked', 'shop.example')).toMatch(/blocked this browser.*stop and tell the user/);
  });
});

describe('challenge helpers', () => {
  it('pickChallengeHeaders keeps only detection headers (never cookies / auth)', () => {
    expect(pickChallengeHeaders({ 'CF-Mitigated': 'challenge', Server: 'cloudflare', 'set-cookie': 'sid=SECRET', authorization: 'Bearer X', 'x-amzn-waf-action': 'captcha' }))
      .toEqual({ 'cf-mitigated': 'challenge', server: 'cloudflare', 'x-amzn-waf-action': 'captcha' });
    expect(pickChallengeHeaders(null)).toEqual({});
  });

  it('isChallengeElement: in-page flag or a CAPTCHA-ish selector', () => {
    expect(isChallengeElement({ challenge: true })).toBe(true);
    expect(isChallengeElement({ selector: '#px-captcha' })).toBe(true);
    expect(isChallengeElement({ selector: 'div.geetest_slider_button' })).toBe(true);
    expect(isChallengeElement({ selector: '#email', name: 'Email' })).toBe(false);
    expect(isChallengeElement(null)).toBe(false);
  });

  it('in-page sources compile (no DOM lib: built from strings)', () => {
    expect(typeof CHALLENGE_PROBE_FN).toBe('function');
    expect(typeof FRAME_BOX_FN).toBe('function');
    // The element describer embeds the challenge check and still parses.
    expect(() => new Function('el', `return (${DESCRIBE_ELEMENT_JS})(el);`)).not.toThrow();
  });

  it('waitForChallengeChange: needs N consecutive confirmations; unknown neither confirms nor resets', async () => {
    const seq: Array<ChallengeInfo | null | 'unknown'> = [
      { vendor: 'cloudflare', state: 'self-clearing', host: 'h', hint: '' }, null, 'unknown', null,
    ];
    let i = 0;
    const r = await waitForChallengeChange(null, { timeoutMs: 5000, intervalMs: 50, confirmations: 2, detect: async () => seq[Math.min(i++, seq.length - 1)]! });
    expect(r.timedOut).toBe(false);
    expect(r.challenge).toBeNull();
    expect(i).toBe(4);
  });

  it('waitForChallengeChange times out with the last known verdict and honours the abort signal', async () => {
    const ch: ChallengeInfo = { vendor: 'recaptcha', state: 'needs-human', host: 'h', hint: '' };
    const r = await waitForChallengeChange(null, { timeoutMs: 150, intervalMs: 50, detect: async () => ch });
    expect(r.timedOut).toBe(true);
    expect(r.challenge).toEqual(ch);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    await expect(waitForChallengeChange(null, { timeoutMs: 5000, intervalMs: 20, signal: ac.signal, detect: async () => ch })).rejects.toThrow(/ABORTED/);
  });
});

// ── item 5: takeover ownership, the tool's shape, Sentinel, relevance ─────────

describe('takeover ownership (compare-and-release, never stolen)', () => {
  it('setTakeover(true) never steals; releaseTakeover only by the owner; timed wait', async () => {
    const m = new QodexBrowserManager({ profilesDir: path.join(os.tmpdir(), 'qx-ho-none') });
    expect(m.setTakeover(true, 'control')).toBe(true);
    expect(m.setTakeover(true, 'handoff:ho_a')).toBe(false);
    expect(m.status().takeoverBy).toBe('control');
    expect(m.releaseTakeover('handoff:ho_a')).toBe(false);
    expect(m.isTakeover()).toBe(true);
    expect(await m.waitForTakeoverEnd(undefined, 30)).toBe(false);
    const ended = m.waitForTakeoverEnd(undefined, 5000);
    expect(m.releaseTakeover('control')).toBe(true);
    expect(await ended).toBe(true);
    expect(m.isTakeover()).toBe(false);
    // An owned hand-off takeover; an explicit hand-back (off) always releases.
    expect(m.setTakeover(true, 'handoff:ho_b')).toBe(true);
    expect(m.setTakeover(true, 'handoff:ho_b')).toBe(true); // same owner: fine
    m.setTakeover(false, 'terminal');
    expect(m.isTakeover()).toBe(false);
    expect(await m.waitForTakeoverEnd()).toBe(true);
    const ac = new AbortController();
    m.setTakeover(true, 'control');
    const w = m.waitForTakeoverEnd(ac.signal);
    ac.abort();
    await expect(w).rejects.toThrow(/ABORTED/);
    m.setTakeover(false);
  });
});

describe('browser_request_human — shape, Sentinel, relevance', () => {
  const tool = new BrowserRequestHumanTool();

  it('is registered, waits without a tool timeout, is not read-only, has a short description', () => {
    expect(BROWSER_TOOL_CLASSES.map(C => new C().name)).toContain('browser_request_human');
    expect(tool.timeoutSeconds).toBe(0);
    expect(tool.isReadOnly).toBe(false);
    expect(tool.untrustedOutput).toBe(true);
    expect(tool.description.length).toBeLessThan(220);
    const props = (tool.schema().function.parameters as any).properties;
    expect(props.reason.description).toBeTruthy();
    expect(props.timeout_sec.description).toBeTruthy();
  });

  it('options have unique first letters; the safe answer is cancel', () => {
    expect(HANDOFF_OPTIONS).toEqual(['done', 'cancel']);
    expect(new Set(HANDOFF_OPTIONS.map(o => o[0])).size).toBe(2);
    expect(safeOption(HANDOFF_OPTIONS)).toBe('cancel');
    expect(normalizeAnswer('d', HANDOFF_OPTIONS)).toBe('done');
    expect(normalizeAnswer('no', HANDOFF_OPTIONS)).toBe('cancel');
  });

  it('Sentinel classifies it low risk (it only waits) — never a prompt of its own', () => {
    expect(isGuardedTool('browser_request_human')).toBe(true);
    const c = classifyAction('browser_request_human', { reason: 'solve the CAPTCHA' }, { config: { ...DEFAULT_SENTINEL_CONFIG }, url: 'https://shop.example/login' });
    expect(c.risk).toBe('low');
    expect(c.category).toBeNull();
  });

  it('relevance gating surfaces the browser family (incl. the hand-off) for CAPTCHA talk, EN + FA', () => {
    const names = ['read_file', 'shell', 'browser_navigate', 'browser_request_human', 'docker_ps'];
    for (const t of ['there is a captcha on the signup page, help me', 'کپچا رو چطوری رد کنم؟']) {
      const r = selectRelevantToolNames(names, t);
      expect(r.selected.has('browser_request_human'), t).toBe(true);
      expect(r.selected.has('docker_ps')).toBe(false);
    }
  });

  it('the prompt names the vendor and host, never a URL query; the reason is cleaned', () => {
    expect(cleanReason('solve it at https://x.example/a?__cf_chl_tk=SECRET#frag\nnow')).toBe('solve it at https://x.example/a now');
    const p = handoffPrompt('solve the CAPTCHA', { vendor: 'recaptcha', state: 'needs-human', host: 'shop.example', hint: '' }, 'shop.example', 600_000);
    expect(p).toContain('reCAPTCHA on shop.example');
    expect(p).toContain('continues by itself');
    expect(p).toMatch(/"done".*"cancel"/);
    expect(handoffPrompt('approve the login on your phone', null, 'bank.example', 60_000)).toContain('On bank.example');
  });

  it("challengeHandoff 'report': no hand-off (refused before touching the browser); the [CHALLENGE] line says tell the user", async () => {
    const mgr = new QodexBrowserManager({ profilesDir: path.join(os.tmpdir(), 'qx-ho-report'), config: { challengeHandoff: 'report' } });
    const r = await runHandoff({ mgr, ctx: { cwd: '/tmp', signal: new AbortController().signal, emit: () => {} } as any, reason: 'x' });
    expect(r.outcome).toBe('refused');
    expect(mgr.isTakeover()).toBe(false);
    const ch = { vendor: 'hcaptcha' as const, state: 'needs-human' as const, host: 'a.example', hint: '' };
    expect(formatChallengeLine(ch, 'report')).toMatch(/^\[CHALLENGE\] hCaptcha on a\.example needs a human\..*Stop and tell the user/);
    expect(formatChallengeLine(ch, 'auto')).toContain('browser_request_human');
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(600_000)).toBe('10 min');
  });

  it('refuses to start when the browser is not open', async () => {
    const mgr = new FakeManager();
    mgr.running = false;
    setBrowserManagerForTests(mgr);
    try {
      const r = await tool.execute({ reason: 'x' }, { cwd: '/tmp', signal: new AbortController().signal, emit: () => {} } as any);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/not open yet/);
    } finally {
      setBrowserManagerForTests(null);
    }
  });
});
