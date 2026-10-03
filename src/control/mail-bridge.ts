/**
 * Mail automation in the control center.
 *
 *  - startMailTimelineBridge(): mirror mail events from other processes (the watcher
 *    daemon, mission workers that auto-replied) onto this process's bus, so the
 *    Activity timeline shows "new mail from …", "auto-replied to …", rule runs and
 *    grant changes. Started by startControlCenter (server.ts); reference-counted.
 *
 *  - registerMailControl(): read-mostly actions for the dashboard / scripts (wire it
 *    next to registerMissionControl):
 *      mail.status         → { text }              watcher, rules, reply grants
 *      mail.grants         → [{ id, kind, account, from, maxPerDay, usedToday, expiresAt, createdBy, expired }]
 *      mail.grants.revoke  { id }                  revoking only narrows what QodeX may do
 *      mail.rules          → [{ id, when, task, cwd, mode, enabled, preset, runs }]
 *      mail.events         { limit? } → recent mail events (clipped, secret-masked)
 *
 * Creating a grant is deliberately NOT an action here: grants come only from the TUI's
 * /allow, `qodex grant add`, Telegram /allow or a human's approval click. Never throws.
 */

import { registerControlAction } from './server.js';
import { logger } from '../utils/logger.js';

function refCounted(setup: () => () => void): () => () => void {
  let active: { refs: number; dispose: () => void } | null = null;
  return () => {
    if (!active) active = { refs: 0, dispose: setup() };
    const held = active;
    held.refs++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (active !== held) return;
      held.refs--;
      if (held.refs <= 0) {
        active = null;
        try { held.dispose(); } catch { /* ignore */ }
      }
    };
  };
}

/** Mirror other processes' mail events onto this bus (idempotent). Returns a release function. */
export const startMailTimelineBridge = refCounted(() => {
  let disposed = false;
  let stop: () => void = () => {};
  void import('../grants/mail-events.js')
    .then(m => { if (!disposed) stop = m.startMailEventBridge(); })
    .catch(() => {});
  return () => { disposed = true; stop(); };
});

function body(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** Register the mail.* control actions (idempotent). Returns a release function. */
export const registerMailControl = refCounted(() => {
  const offs: Array<() => void> = [];
  try {
    offs.push(registerControlAction('mail.status', async () => {
      const { runMailAutomationCommand } = await import('../mail/rules.js');
      return { text: await runMailAutomationCommand(['status'], { origin: 'control' }) };
    }));
    offs.push(registerControlAction('mail.grants', async () => {
      const { getGrantStore } = await import('../grants/store.js');
      return (await getGrantStore().listWithUsage()).map(r => ({ ...r.grant, usedToday: r.usedToday, expired: r.expired }));
    }));
    offs.push(registerControlAction('mail.grants.revoke', async (b: unknown) => {
      const id = typeof body(b).id === 'string' ? String(body(b).id).trim() : '';
      if (!id) throw new Error('[BAD_REQUEST] "id" is required');
      const { getGrantStore } = await import('../grants/store.js');
      const g = await getGrantStore().revoke(id);
      if (!g) throw new Error(`[GRANT_NOT_FOUND] No grant matches "${id}"`);
      const { publishMailEvent } = await import('../grants/mail-events.js');
      void publishMailEvent('grant-revoked', { grantId: g.id, by: 'control' });
      return { ok: true, id: g.id };
    }));
    offs.push(registerControlAction('mail.rules', async () => {
      const { getMailRuleStore, describeMatch } = await import('../mail/rules.js');
      return (await getMailRuleStore().list()).map(r => ({ id: r.id, when: describeMatch(r.match), task: r.task, cwd: r.cwd, mode: r.mode, enabled: r.enabled, preset: r.preset ?? null, runs: r.runs ?? 0 }));
    }));
    offs.push(registerControlAction('mail.events', async (b: unknown) => {
      const { recentMailEvents } = await import('../grants/mail-events.js');
      return recentMailEvents(Math.min(200, Number(body(b).limit) || 50));
    }));
  } catch (e) {
    logger.warn('Mail control actions unavailable', { err: e instanceof Error ? e.message : String(e) });
  }
  return () => { for (const off of offs) { try { off(); } catch { /* ignore */ } } };
});
