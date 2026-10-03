/**
 * Credential vault — encrypted logins the agent can fill into the right site's
 * fields (browser_fill_secret) without ever seeing them.
 */

export {
  Vault, getVault, setVaultForTests, encryptVault, decryptVault, normalizeOrigin, formatOrigin, matchOrigin,
  validateEntryName,
  type VaultEntry, type VaultEntryInput, type VaultEntryPatch, type VaultEntrySummary, type NormalizedOrigin, type OriginMatch,
  type ImportConflict, type AddManyResult,
} from './vault.js';
export {
  VaultKeyStore, getVaultKey, vaultKeyStore, keyFingerprint, keyBackendLabel, isKeyBackendName, spawnRunner, KEY_BACKENDS,
  type KeyBackendName, type CommandRunner, type KeyStatus, type MigrateResult,
} from './keystore.js';
export {
  totp, totpFromKey, hotp, base32Decode, base32Encode, totpRemainingSeconds, parseTotpInput,
  type TotpAlgorithm, type TotpOptions, type TotpSpec,
} from './totp.js';
export { BrowserFillSecretTool, VaultListTool, VaultGenerateAndFillTool, generatePassword, VAULT_TOOL_CLASSES } from './tools.js';
export { BrowserLoginTool } from './login.js';
export { buildVaultCommand, readHiddenLine, type VaultCommandIO } from './command.js';
