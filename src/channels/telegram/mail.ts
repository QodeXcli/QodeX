/**
 * Telegram side of the mail automation: notices for mail events (new mail,
 * auto-replies, rule runs, grants) and the paired chat's `/allow` and `/mail`
 * commands.
 *
 * A paired chat is a human surface: `/allow mail-replies …` here creates a
 * standing grant exactly like the TUI's `/allow` (src/grants/command.ts), and
 * `/mail rule add …` creates a rule (src/mail/rules.ts). Email text shown here
 * (sender, subject, snippet) is untrusted data: always HTML-escaped and
 * secret-masked, never interpreted.
 */

import { esc, maskOutbound, type Lang, type NoticeView } from './format.js';

function pick(d: Record<string, unknown>, k: string): string {
  const v = d[k];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

const T = {
  en: {
    newMail: 'New mail',
    from: 'From',
    subject: 'Subject',
    flagged: '⚠ Possible prompt-injection attempt in this email — QodeX treats it as data and will not auto-reply.',
    autoReplied: (to: string) => `↩️ <b>Auto-replied</b> to ${to}`,
    autoReplyFailed: (to: string) => `❌ <b>Auto-reply failed</b> to ${to}`,
    ruleRun: (rule: string) => `▶️ <b>Rule ${rule}</b> started`,
    draftOnly: (rule: string) => `⚠ <b>Rule ${rule}: draft only</b> — this email looked like a prompt-injection attempt, so nothing will be sent without you.`,
    ruleError: (rule: string) => `❌ <b>Rule ${rule}</b> could not start`,
    grantCreated: '🔓 <b>Standing grant created</b>',
    grantRevoked: '🔒 <b>Standing grant revoked</b>',
    watch: 'Mail watcher',
    revokeHint: 'Revoke: /allow revoke',
  },
  fa: {
    newMail: 'ایمیل تازه',
    from: 'از',
    subject: 'موضوع',
    flagged: '⚠ احتمال تزریق دستور (prompt injection) در این ایمیل — QodeX آن را فقط داده می‌داند و خودکار پاسخ نمی‌دهد.',
    autoReplied: (to: string) => `↩️ <b>پاسخ خودکار</b> به ${to} فرستاده شد`,
    autoReplyFailed: (to: string) => `❌ <b>پاسخ خودکار</b> به ${to} ناموفق بود`,
    ruleRun: (rule: string) => `▶️ <b>قاعدهٔ ${rule}</b> اجرا شد`,
    draftOnly: (rule: string) => `⚠ <b>قاعدهٔ ${rule}: فقط پیش‌نویس</b> — این ایمیل مشکوک به تزریق دستور بود، پس بدون شما چیزی فرستاده نمی‌شود.`,
    ruleError: (rule: string) => `❌ <b>قاعدهٔ ${rule}</b> اجرا نشد`,
    grantCreated: '🔓 <b>مجوز دائمی ساخته شد</b>',
    grantRevoked: '🔒 <b>مجوز دائمی لغو شد</b>',
    watch: 'پایشگر ایمیل',
    revokeHint: 'لغو: /allow revoke',
  },
};

/** Telegram notice for a `{kind:'mail'}` bus event. PURE. */
export function formatMailNotice(type: string, data: unknown, lang: Lang): NoticeView | null {
  const S = T[lang] ?? T.en;
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const line = (label: string, v: string, max = 200) => (v ? `${label}: ${esc(maskOutbound(v), max)}` : '');
  const join = (xs: string[]) => xs.filter(Boolean).join('\n');
  const account = pick(d, 'account');
  const acct = account ? ` · <i>${esc(account, 60)}</i>` : '';
  switch (type) {
    case 'new-mail': {
      const snippet = pick(d, 'snippet');
      return {
        text: join([
          `📬 <b>${S.newMail}</b>${acct}`,
          line(S.from, pick(d, 'from'), 160),
          line(S.subject, pick(d, 'subject'), 200),
          snippet ? `<blockquote>${esc(maskOutbound(snippet), 240)}</blockquote>` : '',
          d.flagged === true ? S.flagged : '',
        ]),
        important: d.flagged === true,
      };
    }
    case 'auto-reply':
      return {
        text: join([
          `${S.autoReplied(esc(pick(d, 'to') || '?', 160))}${acct}`,
          line(S.subject, pick(d, 'subject'), 200),
          pick(d, 'grantId') ? `<code>${esc(pick(d, 'grantId'), 20)}</code>${d.cap ? ` · ${esc(pick(d, 'used'), 6)}/${esc(pick(d, 'cap'), 6)}` : ''} · ${S.revokeHint} ${esc(pick(d, 'grantId'), 20)}` : '',
        ]),
        important: true,
      };
    case 'auto-reply-failed':
      return { text: join([S.autoReplyFailed(esc(pick(d, 'to') || '?', 160)), pick(d, 'error') ? esc(maskOutbound(pick(d, 'error')), 300) : '']), important: true };
    case 'rule-run':
      return {
        text: join([
          `${S.ruleRun(`<code>${esc(pick(d, 'ruleId'), 20)}</code>`)}${pick(d, 'missionId') ? ` → <code>${esc(pick(d, 'missionId'), 40)}</code>` : ''}`,
          pick(d, 'task') ? `<i>${esc(pick(d, 'task'), 300)}</i>` : '',
          line(S.from, pick(d, 'from'), 160),
          line(S.subject, pick(d, 'subject'), 200),
        ]),
        important: false,
      };
    case 'rule-draft-only':
      return { text: join([S.draftOnly(`<code>${esc(pick(d, 'ruleId'), 20)}</code>`), line(S.from, pick(d, 'from'), 160), line(S.subject, pick(d, 'subject'), 200)]), important: true };
    case 'rule-error':
      return { text: join([S.ruleError(`<code>${esc(pick(d, 'ruleId'), 20)}</code>`), pick(d, 'error') ? esc(maskOutbound(pick(d, 'error')), 300) : '']), important: false };
    case 'watch-error':
      return { text: `⚠ ${S.watch}${acct}: ${esc(maskOutbound(pick(d, 'error') || 'error'), 300)}`, important: false };
    case 'grant-created':
      return { text: join([S.grantCreated, pick(d, 'summary') ? esc(pick(d, 'summary'), 400) : '', `${S.revokeHint} ${esc(pick(d, 'grantId'), 20)}`]), important: true };
    case 'grant-revoked':
      return { text: join([S.grantRevoked, `<code>${esc(pick(d, 'grantId'), 20)}</code>${pick(d, 'by') ? ` · ${esc(pick(d, 'by'), 60)}` : ''}`]), important: true };
    default:
      return null;
  }
}

/**
 * Context of a `/allow` or `/mail` command from a paired PRIVATE chat (the bot
 * only calls this after the pairing gate).
 */
export interface TelegramMailCommandContext {
  chatId: number;
  username?: string;
  lang: Lang;
}

/** Split a command's argument text honoring "double quotes", «guillemets» and “curly quotes” (same as src/mail/rules.ts splitArgs). PURE. */
export function splitCommandArgs(text: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"«“]+|"[^"]*"?|«[^»]*»?|“[^”]*”?)+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text ?? '')))) out.push(m[0].replace(/"([^"]*)"?|«([^»]*)»?|“([^”]*)”?/g, '$1$2$3'));
  return out;
}

/**
 * Handle `/allow …` (standing grants) and `/mail …` (watcher status, rules, the
 * reply-all preset). Returns Telegram HTML. Never throws.
 */
export async function handleTelegramMailCommand(cmd: 'allow' | 'mail', args: string, ctx: TelegramMailCommandContext): Promise<string> {
  const who = ctx.username ? `@${ctx.username}` : String(ctx.chatId);
  try {
    const argv = splitCommandArgs(args);
    let text: string;
    if (cmd === 'allow') {
      const { runAllowCommand } = await import('../../grants/command.js');
      text = await runAllowCommand(argv, { origin: 'telegram', detail: who });
    } else {
      const { runMailAutomationCommand } = await import('../../mail/rules.js');
      text = await runMailAutomationCommand(argv, { origin: 'telegram', detail: who });
    }
    return `<pre>${esc(text, 3800)}</pre>`;
  } catch (err) {
    return `❌ ${esc(maskOutbound(err instanceof Error ? err.message : String(err)), 600)}`;
  }
}
