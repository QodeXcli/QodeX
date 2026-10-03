/**
 * Startup approval mode from the command line and the user config.
 *
 *   --approval-mode <manual|edits|auto>   explicit mode (aliases as /auto: on, off, …)
 *   --auto                                same as --approval-mode auto
 *   -y, --yes                             same as --auto (headless runs and schedules have
 *                                         always passed it to mean "run unattended"; auto
 *                                         mode is what keeps that safe: critical and
 *                                         outside-project destructive actions need a human,
 *                                         and with no human they are refused)
 *   approval.defaultMode (user config)    used when no flag is given. The config loader
 *                                         only honors it from ~/.qodex/config.yaml — a
 *                                         project's config must not switch a user into auto.
 *
 * PURE — src/index.ts applies the result with setApprovalMode().
 */
import { parseApprovalMode, type ApprovalMode } from '../security/permissions.js';

export interface ApprovalFlags {
  auto?: boolean;
  approvalMode?: string;
  yes?: boolean;
}

/** The mode the flags ask for, or undefined when none was given. Throws on a bad value or a conflict. */
export function approvalModeFromFlags(o: ApprovalFlags): ApprovalMode | undefined {
  let explicit: ApprovalMode | undefined;
  if (o.approvalMode !== undefined) {
    const m = typeof o.approvalMode === 'string' ? parseApprovalMode(o.approvalMode) : null;
    if (!m) throw new Error(`--approval-mode must be manual, edits or auto (got "${String(o.approvalMode)}").`);
    explicit = m;
  }
  const autoFlag = o.auto ? '--auto' : o.yes ? '--yes' : null;
  if (explicit && autoFlag && explicit !== 'auto') {
    throw new Error(`--approval-mode ${explicit} conflicts with ${autoFlag} (which means auto).`);
  }
  return explicit ?? (autoFlag ? 'auto' : undefined);
}

/** The mode a session starts in: flags, else the user config's approval.defaultMode, else manual. */
export function startupApprovalMode(
  o: ApprovalFlags,
  config?: { approval?: { defaultMode?: unknown } } | null,
): { mode: ApprovalMode; source: 'flag' | 'config' | 'default' } {
  const fromFlags = approvalModeFromFlags(o);
  if (fromFlags) return { mode: fromFlags, source: 'flag' };
  const cfg = config?.approval?.defaultMode;
  const fromConfig = typeof cfg === 'string' ? parseApprovalMode(cfg) : null;
  if (fromConfig) return { mode: fromConfig, source: 'config' };
  return { mode: 'manual', source: 'default' };
}
