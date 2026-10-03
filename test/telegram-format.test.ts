import { describe, it, expect } from 'vitest';
import {
  escapeHtml, langOf, esc, htmlToPlain, buildCallbackData, parseCallbackData, approvalKeyboard,
  formatApproval, formatOutcome, formatMissionNotice, formatSentinelNotice, formatMissionStatus,
  formatMissionList, formatStatus, formatScreenCaption, strings, optionLabel, faDigits, redactUrlSecrets,
  MAX_MESSAGE_CHARS,
} from '../src/channels/telegram/format.js';
import { parseCommand, NotificationLimiter } from '../src/channels/telegram/bot.js';

describe('escaping + language', () => {
  it('escapes HTML-significant characters and truncates before escaping', () => {
    expect(escapeHtml('<a href="x">Tom & Jerry</a>')).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;');
    expect(esc('&&&&&', 3)).toBe('&amp;&amp;…');
    expect(htmlToPlain('<b>a</b> &lt;b&gt; &amp; c')).toBe('a <b> & c');
  });
  it('picks Persian for fa* language codes', () => {
    expect(langOf('fa')).toBe('fa');
    expect(langOf('fa-IR')).toBe('fa');
    expect(langOf('en-US')).toBe('en');
    expect(langOf(undefined)).toBe('en');
    expect(faDigits(2026)).toBe('۲۰۲۶');
  });
});

describe('callback data', () => {
  it('round-trips ap:<id>:<index> within 64 bytes', () => {
    const d = buildCallbackData('ap_AbCdEfGh', 1)!;
    expect(d).toBe('ap:ap_AbCdEfGh:1');
    expect(parseCallbackData(d)).toEqual({ id: 'ap_AbCdEfGh', index: 1 });
    expect(buildCallbackData('x'.repeat(70), 0)).toBeNull();
    expect(parseCallbackData('nope')).toBeNull();
    expect(parseCallbackData('ap:a:b')).toBeNull();
    expect(parseCallbackData(undefined)).toBeNull();
  });
  it('builds one button per option with localized labels', () => {
    const en = approvalKeyboard('ap_1', ['yes', 'no', 'always'], 'en');
    expect(en.inline_keyboard).toHaveLength(1);
    expect(en.inline_keyboard[0].map((b) => b.text)).toEqual(['✅ Yes', '❌ No', '♾ Always']);
    expect(en.inline_keyboard[0].map((b) => b.callback_data)).toEqual(['ap:ap_1:0', 'ap:ap_1:1', 'ap:ap_1:2']);
    for (const b of en.inline_keyboard[0]) expect(Buffer.byteLength(b.callback_data!)).toBeLessThanOrEqual(64);
    const fa = approvalKeyboard('ap_1', ['yes', 'no'], 'fa');
    expect(fa.inline_keyboard[0].map((b) => b.text)).toEqual(['✅ بله', '❌ خیر']);
    const many = approvalKeyboard('ap_1', ['accept', 'edit', 'continue', 'reject'], 'en');
    expect(many.inline_keyboard).toHaveLength(2);
    expect(optionLabel('continue', 'en')).toBe('continue');
  });
});

describe('approval cards', () => {
  const card = { id: 'ap_1', prompt: 'Click "Place order" on <shop>?', options: ['yes', 'no'], category: 'purchase', risk: 'critical', source: 'browser_click' };
  it('formats English and Persian cards with escaped prompts', () => {
    const en = formatApproval(card, 'en');
    expect(en).toContain('🔐 <b>Approval needed</b>');
    expect(en).toContain('<i>purchase</i>');
    expect(en).toContain('risk: <b>critical</b>');
    expect(en).toContain('Click &quot;Place order&quot; on &lt;shop&gt;?');
    expect(en).toContain('From: <code>browser_click</code>');
    const fa = formatApproval({ ...card, missionId: 'm_42' }, 'fa');
    expect(fa).toContain('نیاز به تأیید');
    expect(fa).toContain('<i>خرید</i>');
    expect(fa).toContain('ریسک: <b>بحرانی</b>');
    expect(fa).toContain('مأموریت: <code>m_42</code>');
  });
  it('describes outcomes', () => {
    expect(formatOutcome({ answer: 'yes', by: 'telegram' }, ['yes', 'no'], 'en')).toBe('✅ Approved — "Yes" via Telegram');
    expect(formatOutcome({ answer: 'no', by: 'control' }, ['yes', 'no'], 'en')).toBe('⛔ Denied — "No" via control center');
    expect(formatOutcome({ answer: 'no', by: 'timeout' }, ['yes', 'no'], 'en')).toContain('Timed out');
    expect(formatOutcome(null, [], 'en')).toContain('No longer pending');
    expect(formatOutcome({ answer: 'edit', by: 'local' }, ['accept', 'edit', 'continue', 'reject'], 'en')).toBe('☑️ Answered — "edit" via terminal');
    expect(formatOutcome({ answer: 'always', by: 'telegram' }, ['yes', 'no', 'always'], 'en')).toBe('✅ Approved — "Always" via Telegram');
    expect(formatOutcome({ answer: 'yes', by: 'local' }, ['yes', 'no'], 'fa')).toBe('✅ تأیید شد — «بله» از طریق ترمینال');
  });
});

describe('missions + status', () => {
  it('formats mission lists, detail and status', () => {
    const list = formatMissionList([{ id: 'm_1', goal: 'Find <cheap> flights', status: 'running', progress: '2/5' }], 'en');
    expect(list).toContain('▶️ <code>m_1</code> running · 2/5');
    expect(list).toContain('Find &lt;cheap&gt; flights');
    expect(formatMissionList([], 'fa')).toContain('هنوز مأموریتی نیست');
    const detail = formatMissionStatus({
      id: 'm_1', goal: 'g', status: 'completed', steps: [{ title: 'search', status: 'done' }, { title: 'compare', status: 'failed' }],
      milestones: ['found 3 options'], report: 'Best: A', costUsd: 0.0123,
    }, 'fa');
    expect(detail).toContain('تمام شد');
    expect(detail).toContain('✅ ۱. search');
    expect(detail).toContain('❌ ۲. compare');
    expect(detail).toContain('🏁 found 3 options');
    expect(detail).toContain('$0.0123');
    const status = formatStatus({
      botUsername: 'qx_bot',
      browser: { running: true, mode: 'launch', headless: true, profile: 'default', tabs: [{ title: 'Cart', url: 'https://shop.example/cart', active: true }] },
      activeMissions: [],
      pendingApprovals: 2,
    }, 'en');
    expect(status).toContain('@qx_bot');
    expect(status).toContain('Browser: running (launch, headless');
    expect(status).toContain('https://shop.example/cart');
    expect(status).toContain('No active missions');
    expect(status).toContain('Approvals pending: <b>2</b>');
    expect(formatStatus({ browser: null, activeMissions: null, pendingApprovals: 0 }, 'en')).toContain('not available');
    expect(formatScreenCaption('A & B', 'https://x/?a=1&b=2')).toBe('A &amp; B\nhttps://x/?a=1&amp;b=2');
  });

  it('turns mission/sentinel events into notices (and ignores noise)', () => {
    const ms = formatMissionNotice('m_1', 'milestone', { title: 'Logged in', progress: 0.4 }, 'en')!;
    expect(ms.text).toContain('🏁 <b>Milestone</b> · <code>m_1</code> (40%)');
    expect(ms.important).toBe(false);
    expect(formatMissionNotice('m_1', 'completed', { report: 'done <ok>' }, 'en')).toMatchObject({ important: true });
    expect(formatMissionNotice('m_1', 'completed', { report: 'done <ok>' }, 'en')!.text).toContain('done &lt;ok&gt;');
    expect(formatMissionNotice('m_1', 'status', { status: 'failed', error: 'boom' }, 'fa')!.text).toContain('مأموریت شکست خورد');
    expect(formatMissionNotice('m_1', 'step-start', {}, 'en')).toBeNull();
    expect(formatMissionNotice('m_1', 'tool', {}, 'en')).toBeNull();
    const sb = formatSentinelNotice('decision', { action: 'deny', classification: { category: 'payment', summary: 'pay on shaparak.ir' }, tool: 'browser_click' }, 'en')!;
    expect(sb.text).toContain('Sentinel blocked');
    expect(sb.text).toContain('pay on shaparak.ir');
    expect(sb.text).toContain('<i>payment</i>');
    expect(formatSentinelNotice('decision', { action: 'allow' }, 'en')).toBeNull();
  });

  it('has a complete Persian catalog', () => {
    const en = strings('en') as Record<string, unknown>;
    const fa = strings('fa') as Record<string, unknown>;
    expect(Object.keys(fa).sort()).toEqual(Object.keys(en).sort());
    expect(fa.help).toContain('کنترل از راه دور QodeX');
  });
});

describe('review hardening', () => {
  it('strips access keys and credentials from URLs', () => {
    expect(redactUrlSecrets('http://127.0.0.1:7420/?k=abc123')).toBe('http://127.0.0.1:7420/');
    expect(redactUrlSecrets('https://u:p@x.example/a?token=t&q=1#f')).toBe('https://x.example/a?q=1#f');
    expect(redactUrlSecrets('not a url ?k=zzz')).toBe('not a url ');
    expect(redactUrlSecrets('')).toBe('');
    const detail = formatMissionStatus({ id: 'm_1', goal: 'g', status: 'running', liveUrl: 'http://127.0.0.1:7420/?k=SECRET' }, 'en');
    expect(detail).toContain('Live view: http://127.0.0.1:7420/');
    expect(detail).not.toContain('SECRET');
  });

  it('keeps a mission status under Telegram\'s limit by trimming the report', () => {
    const detail = formatMissionStatus({
      id: 'm_1', goal: 'g'.repeat(500), status: 'completed',
      steps: Array.from({ length: 10 }, (_, i) => ({ title: `step ${i} ` + 'x'.repeat(100), status: 'done' })),
      milestones: ['a', 'b'], report: '<r>'.repeat(3000),
    }, 'en');
    expect(htmlToPlain(detail).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(detail).toContain('<b>Report</b>');
    expect(detail).toContain('&lt;r&gt;');
  });

  it('masks secrets in text that leaves the machine (approval prompts, mission reports, URLs)', () => {
    const prompt = [
      `Run: curl -H 'Authorization: Bearer abcDEF0123456789ghiJKL' https://api.example/pay`,
      'export OPENAI_API_KEY=sk-proj-AbCdEf0123456789AbCdEf0123',
      'mysql --password=hunter2hunter2',
      'card 4111 1111 1111 1111 — قیمت ۲۷ اینچ',
    ].join('\n');
    const card = formatApproval({ id: 'ap_1', prompt, options: ['yes', 'no'] }, 'en');
    for (const secret of ['abcDEF0123456789ghiJKL', 'AbCdEf0123456789AbCdEf0123', 'hunter2hunter2', '4111 1111 1111 1111']) {
      expect(card).not.toContain(secret);
    }
    expect(card).toContain('Run: curl');
    expect(card).toContain('https://api.example/pay');
    expect(card).toContain('قیمت ۲۷ اینچ'); // the user's own digits are left alone
    const done = formatMissionNotice('m_1', 'completed', { report: 'Paid with 4111111111111111, receipt sent' }, 'en')!;
    expect(done.text).not.toContain('4111111111111111');
    expect(done.text).toContain('receipt sent');
    const st = formatStatus({
      browser: { running: true, mode: 'launch', headless: true, profile: 'default', tabs: [{ title: 'Callback', url: 'https://app.example/cb?access_token=ya29.AbCdEfGhIjKlMnOpQrStUv', active: true }] },
      activeMissions: [], pendingApprovals: 0,
    }, 'en');
    expect(st).not.toContain('ya29.AbCdEfGhIjKlMnOpQrStUv');
    expect(formatScreenCaption('t', 'https://app.example/cb?access_token=ya29.AbCdEfGhIjKlMnOpQrStUv')).not.toContain('ya29.');
  });

  it('describes automatic expiries as cancelled, not as a human denial', () => {
    for (const by of ['worker-exited', 'mission-ended', 'cancelled', 'expired', 'cancel', 'local-error']) {
      expect(formatOutcome({ answer: 'no', by }, ['yes', 'no'], 'en')).toBe('⚪ Cancelled — denied automatically');
    }
    expect(formatOutcome({ answer: 'no', by: 'telegram:@alice' }, ['yes', 'no'], 'en')).toBe('⛔ Denied — "No" via Telegram');
  });

  it('marks state notices for de-duplication and shows why a mission paused', () => {
    expect(formatMissionNotice('m_1', 'status', { to: 'completed', status: 'completed' }, 'en')!.dedupeKey).toBe('completed');
    expect(formatMissionNotice('m_1', 'completed', {}, 'en')!.dedupeKey).toBe('completed');
    expect(formatMissionNotice('m_1', 'milestone', { title: 't' }, 'en')!.dedupeKey).toBeUndefined();
    const paused = formatMissionNotice('m_1', 'paused', { status: 'paused', error: 'worker exited' }, 'en')!;
    expect(paused.text).toContain('worker exited');
  });
});

describe('command parsing + limiter', () => {
  it('parses /cmd@bot args and ignores other bots', () => {
    expect(parseCommand('/mission buy a book', 'qx_bot')).toEqual({ cmd: 'mission', args: 'buy a book' });
    expect(parseCommand('/Status@qx_bot', 'qx_bot')).toEqual({ cmd: 'status', args: '' });
    expect(parseCommand('/status@other_bot', 'qx_bot')).toBeNull();
    expect(parseCommand('hello', 'qx_bot')).toBeNull();
    expect(parseCommand('/mission  line1\nline2')).toEqual({ cmd: 'mission', args: 'line1\nline2' });
  });
  it('limits notifications in a sliding window', () => {
    const l = new NotificationLimiter(2, 1000);
    expect(l.take(0)).toBe(true);
    expect(l.take(10)).toBe(true);
    expect(l.take(20)).toBe(false);
    expect(l.take(1001)).toBe(true);
  });
});
