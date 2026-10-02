/**
 * Filesystem locations for QodeX's agent-platform features (dedicated browser,
 * missions, workflows, sentinel, vault, channels).
 *
 * Everything lives under QODEX_HOME (~/.qodex) so a single directory holds the
 * agent's "computer": its browser profiles, downloads, recordings, mission logs
 * and audit trail. Paths are plain constants (like QODEX_SESSION_DB) plus a few
 * helpers that take an explicit base dir so tests can point them at a tmp dir
 * without re-importing defaults.ts.
 */

import * as path from 'path';
import { QODEX_HOME } from './defaults.js';

/** Root of the dedicated QodeX Browser state (profiles, downloads, screenshots). */
export const QODEX_BROWSER_DIR = path.join(QODEX_HOME, 'browser');
/** Persistent Chromium user-data dirs, one per named profile. */
export const QODEX_BROWSER_PROFILES_DIR = path.join(QODEX_BROWSER_DIR, 'profiles');
/** Where files downloaded by the agent's browser land. */
export const QODEX_BROWSER_DOWNLOADS_DIR = path.join(QODEX_BROWSER_DIR, 'downloads');
/** Screenshots taken by browser / desktop tools. */
export const QODEX_SCREENSHOTS_DIR = path.join(QODEX_HOME, 'screenshots');
/** Mission logs + per-mission artifacts (DB rows live in sessions.db). */
export const QODEX_MISSIONS_DIR = path.join(QODEX_HOME, 'missions');
/** Recorded / learned workflows (JSON), replayable by `workflow_run`. */
export const QODEX_WORKFLOWS_DIR = path.join(QODEX_HOME, 'workflows');
/** Sentinel audit trail + policy state. */
export const QODEX_SENTINEL_DIR = path.join(QODEX_HOME, 'sentinel');
/** Encrypted credential vault (secrets the model never sees). */
export const QODEX_VAULT_FILE = path.join(QODEX_HOME, 'vault.json');
/** Key for the vault (0600). Kept separate so the vault file alone is useless. */
export const QODEX_VAULT_KEY_FILE = path.join(QODEX_HOME, '.vault-key');
/** Messaging channels state (Telegram pairing etc). */
export const QODEX_CHANNELS_DIR = path.join(QODEX_HOME, 'channels');

/** Resolve the user-data dir for a named browser profile. Names are sanitized so
 *  a model-supplied profile name can never escape the profiles dir. */
export function browserProfileDir(name: string, base: string = QODEX_BROWSER_PROFILES_DIR): string {
  return path.join(base, sanitizeName(name) || 'default');
}

/** Keep `[A-Za-z0-9._-]`, collapse everything else to '-', strip leading dots. */
export function sanitizeName(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 64);
}
