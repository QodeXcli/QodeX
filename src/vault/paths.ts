/**
 * Where the vault's key-related files live (besides QODEX_VAULT_FILE / QODEX_VAULT_KEY_FILE
 * in src/config/paths.ts). Plain constants with no other imports, so the Sentinel policy,
 * the browser session and the desktop tools can protect them without pulling in the vault.
 *
 *   vault-keystore.json   which backend holds the vault key (file / OS keychain) and the
 *                         key's fingerprint. It holds no secret, but it decides whether a
 *                         missing key file means "fresh install" (mint a key) or "the key
 *                         is gone" (refuse), so the agent must not be able to edit it.
 *   .vault-key.dpapi      the vault key sealed with Windows DPAPI (windows backend only).
 *
 * Both sit NEXT TO the key file, so a Vault built on a temp key file (tests) keeps its
 * keystore record in the same temp dir (a key file not named .vault-key gets
 * `<keyFile>.keystore.json` / `<keyFile>.dpapi` instead).
 */

import * as path from 'path';
import { QODEX_HOME } from '../config/defaults.js';

/** Basename of the keystore record, kept in the key file's directory. */
export const VAULT_KEYSTORE_BASENAME = 'vault-keystore.json';
/** Basename of the DPAPI-sealed key (windows backend), kept in the key file's directory. */
export const VAULT_KEY_DPAPI_BASENAME = '.vault-key.dpapi';

/** ~/.qodex/vault-keystore.json */
export const QODEX_VAULT_KEYSTORE_FILE = path.join(QODEX_HOME, VAULT_KEYSTORE_BASENAME);
/** ~/.qodex/.vault-key.dpapi */
export const QODEX_VAULT_KEY_DPAPI_FILE = path.join(QODEX_HOME, VAULT_KEY_DPAPI_BASENAME);

/** Every key-related file the agent must never read or write (beyond vault.json / .vault-key). */
export const VAULT_KEY_ARTIFACTS = [QODEX_VAULT_KEYSTORE_FILE, QODEX_VAULT_KEY_DPAPI_FILE];
