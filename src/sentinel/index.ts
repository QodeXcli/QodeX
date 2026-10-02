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
  Sentinel, getSentinel, setSentinelForTests, formatSentinelStatus,
  type SentinelOptions, type SentinelVerdict,
} from './guard.js';
export {
  classifyAction, classifyNavigation, isGuardedTool, normalizeText, toAsciiDigits, detectSecrets, maskSecrets,
  describeSecret, luhnValid, ibanValid, hostMatchesDomain, normalizeDomainPattern, isLoopbackHost, isPrivateHost,
  isPaymentGatewayHost, isProtectedPath, textHitsProtectedMarker, isSecretFile, categoriesForLabel, parseTarget,
  DEFAULT_PROTECTED_PATHS,
  type PolicyClassification, type PolicyContext, type ProtectedPaths, type WorkflowLike, type SecretKind, type SecretMatch,
} from './policy.js';
export {
  scanInjection, fenceUntrusted, injectionBanner, isFenced, unfenceForDisplay, decodeTagChars,
  type ScoredFinding,
} from './injection.js';
export { SentinelAudit, redactForAudit, type AuditRecord } from './audit.js';
