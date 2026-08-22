/**
 * Headless permission choice — fail-safe.
 *
 * Edit approval offers `accept/always/edit/continue/reject`, not `yes/no`.
 * The old handler looked for an option starting with `y`, missed, then on the
 * deny path looked for `n`, missed again, and returned `options[0]` which is
 * `accept`. Headless without an explicit yes must never write.
 */

const AFFIRM = new Set(['accept', 'always', 'always yes', 'always-yes', 'yes', 'y']);
const DENY = new Set(['reject', 'no', 'n', 'deny']);

export function headlessAskChoice(
  options: string[],
  autoApproveAll: boolean,
): { choice: string; denied: boolean } {
  const opts = options.length ? options : ['yes', 'no'];

  if (autoApproveAll) {
    const hit = opts.find(o => AFFIRM.has(o.trim().toLowerCase()));
    if (hit) return { choice: hit, denied: false };
  }

  const deny = opts.find(o => DENY.has(o.trim().toLowerCase()));
  return { choice: deny ?? 'reject', denied: true };
}
