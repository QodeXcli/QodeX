/**
 * Credential vault — encrypted logins the agent can fill into the right site's
 * fields (browser_fill_secret) without ever seeing them.
 */

export {
  Vault, getVault, setVaultForTests, encryptVault, decryptVault, normalizeOrigin, formatOrigin, matchOrigin,
  validateEntryName,
  type VaultEntry, type VaultEntryInput, type VaultEntrySummary, type NormalizedOrigin, type OriginMatch,
} from './vault.js';
export {
  totp, totpFromKey, hotp, base32Decode, base32Encode, totpRemainingSeconds, parseTotpInput,
  type TotpAlgorithm, type TotpOptions, type TotpSpec,
} from './totp.js';
export { BrowserFillSecretTool, VaultListTool, VAULT_TOOL_CLASSES } from './tools.js';
export { buildVaultCommand, readHiddenLine, type VaultCommandIO } from './command.js';
