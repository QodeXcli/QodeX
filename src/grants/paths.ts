/**
 * Where standing grants and the mail automation (watcher, rules) keep their state.
 * Constants only — imported by Sentinel's policy (pure), so nothing heavy here.
 *
 * All of these are QodeX's own trust stores: a standing grant lets an email go out
 * without a prompt, a rule's task is a trusted instruction, and the received-mail
 * index decides what counts as "a reply to a message received in this account".
 * Sentinel therefore hard-protects them (the agent can neither read nor write them
 * with its file / shell tools); only the human surfaces in this module change them.
 */

import * as path from 'path';
import { QODEX_HOME } from '../config/defaults.js';

/** Standing grants (0600). Created only by human surfaces (TUI /allow, `qodex grant add`, Telegram /allow, an approval click). */
export const QODEX_GRANTS_FILE = path.join(QODEX_HOME, 'grants.json');

/** Mail automation state dir (0700): rules, watcher state, received-mail index, pid file, event feed, log. */
export const QODEX_MAIL_AUTO_DIR = path.join(QODEX_HOME, 'mail-auto');

/** The mail core's own state (src/mail/paths.ts): encrypted accounts, signed drafts — protected too. */
export { QODEX_MAIL_ACCOUNTS_FILE, QODEX_MAIL_DIR } from '../mail/paths.js';

export const mailAutoPaths = (dir: string = QODEX_MAIL_AUTO_DIR) => ({
  dir,
  rules: path.join(dir, 'rules.json'),
  received: path.join(dir, 'received.json'),
  state: path.join(dir, 'watch-state.json'),
  pid: path.join(dir, 'watch.pid'),
  log: path.join(dir, 'watch.log'),
  events: path.join(dir, 'events.jsonl'),
});
