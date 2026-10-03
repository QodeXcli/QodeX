/**
 * Human surfaces for standing grants:
 *   - TUI         `/allow …`            (src/cli/slash-commands.ts → runAllowCommand, origin 'tui')
 *   - terminal    `qodex grant …`       (buildGrantCommand, origin 'cli')
 *   - Telegram    `/allow …`            (src/channels/telegram/mail.ts, origin 'telegram')
 * all sharing one parser, so they behave the same:
 *
 *   /allow                                   list grants
 *   /allow mail-replies [--account <name>] [--from <addr|@domain>[,…]] [--max-per-day N] [--expires 7d|ISO]
 *   /allow revoke <id|all>
 *
 * There is no tool for any of this (the model can neither create, widen nor read
 * grants), and Sentinel treats `qodex grant add|revoke` run by the agent's shell
 * as a change to QodeX's own safety settings (always an explicit human answer).
 */

import { Command } from 'commander';
import {
  getGrantStore, describeGrant, DEFAULT_MAX_PER_DAY, type GrantOrigin, type GrantStore, type NewGrantInput, type StandingGrant,
} from './store.js';
import { publishMailEvent } from './mail-events.js';

export interface AllowCommandContext {
  /** Which human surface runs it; 'headless' may list / revoke but never create. */
  origin: GrantOrigin | 'headless';
  /** e.g. the Telegram @username. */
  detail?: string;
  store?: GrantStore;
}

export type AllowAction =
  | { action: 'list' }
  | { action: 'help' }
  | { action: 'revoke'; id: string }
  | { action: 'add'; input: NewGrantInput };

const MAIL_KINDS = new Set(['mail-replies', 'mail-reply', 'replies', 'reply', 'mail']);

/** Parse `/allow` arguments (already split, quotes honored). Throws [GRANT_BAD_INPUT]. PURE. */
export function parseAllowArgs(argv: string[]): AllowAction {
  const args = argv.map(String).filter(a => a !== '');
  const first = (args[0] ?? '').toLowerCase();
  if (!first || first === 'list' || first === 'ls') return { action: 'list' };
  if (first === 'help' || first === '--help' || first === '-h') return { action: 'help' };
  if (first === 'revoke' || first === 'rm' || first === 'remove' || first === 'delete') {
    const id = args[1] ?? '';
    if (!id) throw new Error('[GRANT_BAD_INPUT] Usage: /allow revoke <id|all>');
    return { action: 'revoke', id };
  }
  if (!MAIL_KINDS.has(first)) throw new Error(`[GRANT_BAD_INPUT] Unknown grant "${args[0]}". Try: /allow mail-replies [--account a] [--from @domain] [--max-per-day N]`);
  const input: NewGrantInput = { kind: 'mail-reply' };
  const from: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const raw = args[i];
    const eq = raw.indexOf('=');
    const flag = (raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw).toLowerCase();
    const inline = raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`[GRANT_BAD_INPUT] ${flag} needs a value.`);
      return v;
    };
    switch (flag) {
      case '--account': case '-a': input.account = value(); break;
      case '--from': case '--sender': case '-f': from.push(value()); break;
      case '--max-per-day': case '--max': case '--cap': case '-n': input.maxPerDay = Number(value()); break;
      case '--expires': case '--for': case '--until': input.expiresAt = value(); break;
      case '--note': input.note = value(); break;
      default: throw new Error(`[GRANT_BAD_INPUT] Unknown option "${raw}".`);
    }
  }
  if (from.length) input.from = from.join(',');
  return { action: 'add', input };
}

export const ALLOW_HELP = [
  'Standing grants — let QodeX do something without asking each time.',
  '',
  '  /allow                       list grants (with today\'s use)',
  '  /allow mail-replies [--account <name>] [--from <addr|@domain>] [--max-per-day N] [--expires 7d]',
  '                               auto-send REPLIES (no prompt) when ALL hold: same thread as a mail',
  '                               received in that account, only to its original sender, no cc/bcc,',
  '                               no attachments, not a forward, the mail was not flagged as a prompt-',
  `                               injection attempt, under the daily cap (default ${DEFAULT_MAX_PER_DAY}). Anything else still asks you.`,
  '  /allow revoke <id|all>       remove a grant',
  '',
  'Every auto-reply is audited and you are notified (Telegram, desktop, control center).',
].join('\n');

function grantSummary(g: StandingGrant): string {
  return describeGrant(g, 0).split(' · ').slice(1, 5).join(' · ');
}

/** Run `/allow …` for a human surface. Returns plain text. Throws [GRANT_*] on bad input. */
export async function runAllowCommand(argv: string[], ctx: AllowCommandContext): Promise<string> {
  const store = ctx.store ?? getGrantStore();
  const act = parseAllowArgs(argv);
  const by = ctx.detail ? `${ctx.origin}:${ctx.detail}` : ctx.origin;
  switch (act.action) {
    case 'help':
      return ALLOW_HELP;
    case 'list': {
      const rows = await store.listWithUsage();
      if (!rows.length) return 'No standing grants. Every email QodeX sends asks you first.\n\n' + ALLOW_HELP;
      return [`Standing grants (${rows.length}):`, ...rows.map(r => `  ${describeGrant(r.grant, r.usedToday)}`), '', 'Revoke: /allow revoke <id>   (qodex grant revoke <id>)'].join('\n');
    }
    case 'revoke': {
      if (act.id.toLowerCase() === 'all') {
        const n = await store.revokeAll();
        if (n) void publishMailEvent('grant-revoked', { grantId: 'all', by });
        return n ? `✓ Revoked all ${n} standing grant(s). Every email now asks you again.` : 'There were no standing grants.';
      }
      const g = await store.revoke(act.id);
      if (!g) return `No grant matches "${act.id}". List them with /allow.`;
      void publishMailEvent('grant-revoked', { grantId: g.id, by });
      return `✓ Revoked ${g.id} (${grantSummary(g)}).`;
    }
    case 'add': {
      if (ctx.origin === 'headless') {
        throw new Error('[GRANT_HUMAN_ONLY] Standing grants can only be created by you: in the interactive TUI (/allow), a paired Telegram chat, or `qodex grant add` in a terminal.');
      }
      const { grant, updated } = await store.add(act.input, ctx.origin, ctx.detail);
      void publishMailEvent('grant-created', { grantId: grant.id, by, summary: grantSummary(grant) });
      return [
        `${updated ? '✓ Updated' : '✓ Created'} standing grant ${grant.id}: ${grantSummary(grant)}${grant.expiresAt ? ` · until ${grant.expiresAt.slice(0, 16).replace('T', ' ')}` : ''}.`,
        'QodeX may now send same-thread replies to the original sender without asking (no cc/bcc, no attachments,',
        'never for mail flagged as a prompt-injection attempt). Everything else still asks you.',
        `Revoke any time: /allow revoke ${grant.id}`,
      ].join('\n');
    }
  }
}

/** `qodex grant …` — the terminal surface (origin 'cli'). */
export function buildGrantCommand(): Command {
  const cmd = new Command('grant').description('Standing grants: let QodeX auto-send email replies (list / add / revoke)');
  const run = async (argv: string[]) => {
    try {
      process.stdout.write((await runAllowCommand(argv, { origin: 'cli' })) + '\n');
    } catch (e: any) {
      process.stderr.write(`${e?.message ?? e}\n`);
      process.exitCode = 1;
    }
  };
  cmd.command('list', { isDefault: true }).description('List standing grants').action(() => run(['list']));
  cmd.command('add <kind>')
    .description('Create a grant. kind: mail-replies')
    .option('--account <name>', 'Mail account (default: every account)')
    .option('--from <addr|@domain>', 'Only replies to these senders (comma-separated)')
    .option('--max-per-day <n>', `Daily cap (default ${DEFAULT_MAX_PER_DAY})`)
    .option('--expires <when>', 'Expire after a duration (12h, 7d, 2w) or at a date')
    .action((kind: string, o: Record<string, string | undefined>) => {
      const argv = [kind];
      if (o.account) argv.push('--account', o.account);
      if (o.from) argv.push('--from', o.from);
      if (o.maxPerDay) argv.push('--max-per-day', o.maxPerDay);
      if (o.expires) argv.push('--expires', o.expires);
      return run(argv);
    });
  cmd.command('revoke <id>').alias('rm').description('Remove a grant (or "all")').action((id: string) => run(['revoke', id]));
  return cmd;
}
