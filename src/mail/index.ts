/**
 * Mail: accounts (encrypted with the vault key), IMAP/SMTP transport, signed drafts,
 * and the agent's mail tools. Sending is Sentinel-critical ('send'): a human approves
 * every send unless a standing grant (src/grants, src/mail/rules.ts) covers it.
 */

export {
  MailAccountStore, getMailAccounts, setMailAccountsForTests, isEmailAddress, isLoopbackHost, validateAccountName,
  type MailAccountConfig, type MailAccountInput, type MailAccountSecret, type MailAccountSummary, type MailAuthKind, type MailFolders,
} from './accounts.js';
export { MAIL_PRESETS, MAIL_PRESET_IDS, APP_PASSWORD_NOTE_FA, getPreset, detectPreset, type MailPreset, type MailEndpoint } from './presets.js';
export { QODEX_MAIL_ACCOUNTS_FILE, QODEX_MAIL_DIR, QODEX_MAIL_DRAFTS_DIR } from './paths.js';
export { scrubSecrets, safeErrorMessage, secretForms } from './secrets.js';
export {
  makeMessageId, parseMessageId, formatAddress, formatAddresses, asSpecialFolder,
  type MailTransport, type MailSummary, type MailMessage, type MailAddress, type MailAttachmentInfo, type MailAttachmentData,
  type ListQuery, type OutgoingMail, type OutgoingAttachment, type SendResult, type AppendResult, type FolderInfo,
  type SpecialFolder, type TransportCheck, type FolderStatus, type WaitResult,
} from './types.js';
export { InMemoryMailTransport, type FakeMessageInput, type FakeTransportOptions } from './fake.js';
export { ImapSmtpTransport, type ImapSmtpOptions } from './imap-smtp.js';
export { DraftStore, getDraftStore, setDraftStoreForTests, isDraftId, newMessageId, type MailDraft, type DraftReplyInfo, type DraftInput, type SentMarker } from './drafts.js';
export {
  describeOutgoingMail, resolveOutgoingMail, summarizeOutgoingMail, formatOutgoingPrompt, parseAddressList,
  type MailSendArgs, type OutgoingMailDescription,
} from './outgoing.js';
export { MailService, getMailService, setMailServiceForTests, defaultTransportFactory, NO_ACCOUNT_HINT, type MailTransportFactory } from './service.js';
export { approveSend, buildSendPrompt, type SendApproval } from './approval.js';
export {
  MAIL_TOOL_CLASSES, MailListTool, MailReadTool, MailDraftTool, MailSendTool, MailMarkTool, MailMoveTool, MailDownloadAttachmentTool,
  safeAttachmentName,
} from './tools.js';
