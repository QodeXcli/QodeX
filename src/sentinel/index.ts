/**
 * Sentinel — QodeX's guard for consequential outbound actions (purchases,
 * payments, sending, credentials, deletions, risky navigation) and its
 * prompt-injection defense for untrusted tool output.
 *
 * Integration: call `getSentinel().beforeTool(...)` / `.afterTool(...)` around
 * `tool.execute` in ToolRegistry.execute (see guard.ts).
 */

export type { ActionClassification, InjectionFinding, RiskLevel, SentinelDecision, SentinelGuard } from './types.js';
export {
  Sentinel, getSentinel, setSentinelForTests, formatSentinelStatus, isSentinelPrompt, SENTINEL_PROMPT_TITLE,
  type SentinelOptions, type SentinelVerdict,
} from './guard.js';
export {
  classifyAction, classifyNavigation, isGuardedTool, normalizeText, toAsciiDigits, detectSecrets, maskSecrets,
  describeSecret, luhnValid, ibanValid, hostMatchesDomain, normalizeDomainPattern, isLoopbackHost, isPrivateHost,
  isPaymentGatewayHost, isProtectedPath, textHitsProtectedMarker, isSecretFile, categoriesForLabel, parseTarget,
  maskControlTokens, scriptSelectors, isEnterKey, isSpaceKey, DEFAULT_PROTECTED_PATHS,
  type PolicyClassification, type PolicyContext, type ProtectedPaths, type WorkflowLike, type SecretKind, type SecretMatch,
  type ControlCenterLike,
} from './policy.js';
export {
  scanInjection, fenceUntrusted, injectionBanner, isFenced, unfenceForDisplay, decodeTagChars,
  type ScoredFinding,
} from './injection.js';
export { SentinelAudit, redactForAudit, type AuditRecord } from './audit.js';
export {
  AUTO_MODE_ASKS, isAutoModeAskPrompt, isAutonomousContext, markAutonomousPermissions, autoModeAskReason,
  takeSentinelApproval,
} from './auto-mode.js';
