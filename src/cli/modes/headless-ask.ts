/**
 * Headless permission choice — fail-safe.
 *
 * Edit approval offers `accept/always/edit/continue/reject`, not `yes/no`.
 * The old handler looked for an option starting with `y`, missed, then on the
 * deny path looked for `n`, missed again, and returned `options[0]` which is
 * `accept`. Headless without an explicit yes must never write.
 *
 * Auto mode: when the session approval mode is 'auto', the permission engine already ran
 * everything that may run unattended. A prompt that still reaches an unattended asker
 * needs a HUMAN (destructive outside the project, force push / publish / remote deletes,
 * system-level, Sentinel remote-data prompts) — so `autoApproveAll` never affirms it.
 */
import { isAutonomousMode } from '../../security/permissions.js';

const AFFIRM = new Set(['accept', 'always', 'always yes', 'always-yes', 'yes', 'y', 'approve', 'allow']);
const DENY = new Set(['reject', 'no', 'n', 'deny']);

export function headlessAskChoice(
  options: string[],
  autoApproveAll: boolean,
): { choice: string; denied: boolean } {
  const opts = options.length ? options : ['yes', 'no'];

  if (autoApproveAll && !isAutonomousMode()) {
    const hit = opts.find(o => AFFIRM.has(o.trim().toLowerCase()));
    if (hit) return { choice: hit, denied: false };
  }

  const deny = opts.find(o => DENY.has(o.trim().toLowerCase()));
  return { choice: deny ?? 'reject', denied: true };
}
