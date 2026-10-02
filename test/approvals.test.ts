import { describe, it, expect, beforeEach } from 'vitest';
import {
  ApprovalBroker, normalizeAnswer, safeOption, isApproval, brokeredAskUser, getApprovalBroker,
} from '../src/control/approvals.js';
import { getBus } from '../src/control/bus.js';
import { resolveAgentPlatformConfig, resolveSentinelConfig, resolveBrowserConfig } from '../src/config/agent-config.js';
import { browserProfileDir, sanitizeName } from '../src/config/paths.js';

describe('approval answer normalization', () => {
  it('maps synonyms, case and first letters onto options', () => {
    expect(normalizeAnswer('yes', ['yes', 'no'])).toBe('yes');
    expect(normalizeAnswer('YES', ['yes', 'no'])).toBe('yes');
    expect(normalizeAnswer('approve', ['yes', 'no'])).toBe('yes');
    expect(normalizeAnswer('deny', ['yes', 'no', 'always'])).toBe('no');
    expect(normalizeAnswer('✅ yes', ['yes', 'no'])).toBe('yes');
    expect(normalizeAnswer('بله', ['yes', 'no'])).toBe('yes');
    expect(normalizeAnswer('خیر', ['yes', 'no'])).toBe('no');
    expect(normalizeAnswer('a', ['yes', 'no', 'always'])).toBe('always');
    expect(normalizeAnswer('maybe', ['yes', 'no'])).toBeNull();
  });
  it('finds the safe option and classifies approvals', () => {
    expect(safeOption(['accept', 'edit', 'continue', 'reject'])).toBe('reject');
    expect(safeOption(['approve', 'deny'])).toBe('deny');
    expect(safeOption(['go'])).toBeNull();
    expect(isApproval('yes', ['yes', 'no'])).toBe(true);
    expect(isApproval('no', ['yes', 'no'])).toBe(false);
    expect(isApproval('always', ['yes', 'no', 'always'])).toBe(true);
  });
});

describe('ApprovalBroker', () => {
  let b: ApprovalBroker;
  beforeEach(() => { b = new ApprovalBroker(); getBus().reset(); });

  it('fails safe immediately when nobody can answer', async () => {
    const r = await b.request({ prompt: 'buy?', options: ['yes', 'no'] });
    expect(r).toEqual({ answer: 'no', by: 'fallback' });
  });

  it('lets a remote channel answer and retracts everywhere', async () => {
    const delivered: string[] = [];
    const retracted: string[] = [];
    b.registerChannel({ name: 'web', deliver: p => { delivered.push(p.id); }, retract: id => { retracted.push(id); } });
    const pr = b.request({ prompt: 'send email?', options: ['yes', 'no'], category: 'send' });
    await new Promise(r => setTimeout(r, 5));
    expect(b.pending()).toHaveLength(1);
    const id = b.pending()[0].id;
    expect(delivered).toEqual([id]);
    expect(b.resolve(id, 'nope-not-an-option', 'web')).toBe(false);
    expect(b.resolve(id, 'approve', 'web')).toBe(true);
    expect(await pr).toEqual({ answer: 'yes', by: 'web' });
    await new Promise(r => setTimeout(r, 5));
    expect(retracted).toEqual([id]);
    expect(b.pending()).toHaveLength(0);
    const kinds = getBus().recent().map(e => e.kind);
    expect(kinds).toContain('approval.requested');
    expect(kinds).toContain('approval.resolved');
  });

  it('remote answer aborts the local prompt', async () => {
    let localSignal: AbortSignal | undefined;
    b.registerChannel({ name: 'tg', deliver: () => {} });
    const pr = b.request({ prompt: 'pay?', options: ['yes', 'no'] }, (_p, _o, signal) => {
      localSignal = signal;
      return new Promise(() => { /* human never answers locally */ });
    });
    await new Promise(r => setTimeout(r, 5));
    b.resolve(b.pending()[0].id, 'no', 'tg');
    expect(await pr).toEqual({ answer: 'no', by: 'tg' });
    expect(localSignal?.aborted).toBe(true);
  });

  it('serializes local prompts FIFO', async () => {
    const order: string[] = [];
    const local = async (p: string) => { order.push('start:' + p); await new Promise(r => setTimeout(r, 10)); order.push('end:' + p); return 'yes'; };
    const [a, c] = await Promise.all([
      b.request({ prompt: 'A', options: ['yes', 'no'] }, local),
      b.request({ prompt: 'B', options: ['yes', 'no'] }, local),
    ]);
    expect(a.answer).toBe('yes');
    expect(c.answer).toBe('yes');
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });

  it('times out to the safe option', async () => {
    b.registerChannel({ name: 'web', deliver: () => {} });
    const r = await b.request({ prompt: 'x', options: ['accept', 'reject'], timeoutMs: 20 });
    expect(r).toEqual({ answer: 'reject', by: 'timeout' });
  });

  it('brokeredAskUser keeps the askUser signature', async () => {
    getApprovalBroker().reset();
    const ask = brokeredAskUser(async (_p, opts) => (opts ?? [])[0]);
    expect(await ask('ok?', ['yes', 'no'])).toBe('yes');
    const unattended = brokeredAskUser(undefined);
    expect(await unattended('ok?', ['yes', 'no'])).toBe('no');
  });
});

describe('agent platform config resolvers', () => {
  it('returns full defaults for garbage input', () => {
    const c = resolveAgentPlatformConfig(null, {});
    expect(c.browser.headless).toBe(true);
    expect(c.browser.viewport).toEqual({ width: 1280, height: 800 });
    expect(c.sentinel.requireApproval).toEqual(['purchase', 'payment', 'credential', 'send']);
    expect(c.control.port).toBe(7420);
    expect(c.telegram.apiBase).toBe('https://api.telegram.org');
  });
  it('honors YAML values and env overrides, rejecting bad types', () => {
    const b = resolveBrowserConfig({ browser: { headless: true, viewport: { width: 'x', height: 600 }, dialogPolicy: 'bogus', profile: 'work' } }, { QODEX_BROWSER_HEADED: '1' });
    expect(b.headless).toBe(false);
    expect(b.viewport).toEqual({ width: 1280, height: 600 });
    expect(b.dialogPolicy).toBe('accept');
    expect(b.profile).toBe('work');
    const s = resolveSentinelConfig({ sentinel: { requireApproval: ['purchase', 'nonsense', 3], blockedDomains: ['Evil.COM'] } });
    expect(s.requireApproval).toEqual(['purchase']);
    expect(s.blockedDomains).toEqual(['evil.com']);
  });
  it('sanitizes profile names so they cannot escape the profiles dir', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('etc-passwd');
    expect(browserProfileDir('../x', '/base')).toBe('/base/x');
    expect(browserProfileDir('', '/base')).toBe('/base/default');
  });
});
