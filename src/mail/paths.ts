/**
 * Where mail state lives. Everything under QODEX_HOME (~/.qodex):
 *   mail-accounts.enc   accounts + their passwords / tokens, AES-256-GCM with the vault key (0600)
 *   mail/drafts/        local drafts, one signed JSON file each (0600)
 *
 * The accounts file is NOT the vault: browser_fill_secret can never type a mail
 * password into a web page because it only reads vault.json.
 */

import * as path from 'path';
import { QODEX_HOME } from '../config/defaults.js';

/** Encrypted mail accounts (config + app passwords / OAuth tokens). */
export const QODEX_MAIL_ACCOUNTS_FILE = path.join(QODEX_HOME, 'mail-accounts.enc');
/** Mail working state (drafts, caches). */
export const QODEX_MAIL_DIR = path.join(QODEX_HOME, 'mail');
/** Local drafts store. */
export const QODEX_MAIL_DRAFTS_DIR = path.join(QODEX_MAIL_DIR, 'drafts');
