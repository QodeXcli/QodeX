/**
 * Bridge between the Telegram channel's mission interface and the missions store.
 *
 * The bot (src/channels/telegram) is written against a small, transport-shaped
 * `TelegramMissionAdapter`; missions (src/missions) persist everything in
 * sessions.db so a standalone `qodex telegram start` can see — and approve —
 * missions running in detached worker processes. This module maps one onto the
 * other, including `eventsSince` so the bot can notify about milestones and
 * completions written by other processes.
 */

import type {
  TelegramMissionAdapter,
  TelegramMissionApproval,
  TelegramMissionEvent,
  TelegramMissionStatus,
  TelegramMissionSummary,
} from '../channels/telegram/bot.js';
import { getMissionStore, approvalOptions, type MissionStore } from './store.js';
import {
  startMission,
  cancelMission,
  summarizeMission,
  listMissionSummaries,
  answerApprovalById,
  type MissionSummary,
} from './daemon.js';
import { redactLiveUrl } from './tools.js';

function ms(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

function toSummary(s: MissionSummary): TelegramMissionSummary {
  return {
    id: s.id,
    goal: s.goal,
    status: s.status,
    progress: s.steps.total > 0 ? `${s.steps.done}/${s.steps.total} steps` : undefined,
    // The live link is loopback and carries the control center's access token:
    // useless on a phone, and the token must not reach Telegram's servers.
    liveUrl: s.liveUrl ? redactLiveUrl(s.liveUrl) : undefined,
    createdAt: ms(s.createdAt),
    updatedAt: ms(s.updatedAt),
  };
}

const NOTIFY_STATUSES = new Set(['completed', 'failed', 'cancelled', 'paused']);

export function createTelegramMissionAdapter(opts: { store?: MissionStore; defaultCwd?: string } = {}): TelegramMissionAdapter {
  const store = (): MissionStore => opts.store ?? getMissionStore();
  // Open the mission DB now: when it can't be opened, the caller reports "missions
  // unavailable" once at startup instead of every command (and the 3s tick) failing.
  store();

  return {
    async list(limit = 20): Promise<TelegramMissionSummary[]> {
      return listMissionSummaries({ store: store(), limit }).map(toSummary);
    },

    async start(goal: string): Promise<{ id: string; status?: string }> {
      const r = startMission({ goal, cwd: opts.defaultCwd, source: 'telegram' }, { store: store() });
      return { id: r.mission.id, status: r.mission.status };
    },

    async cancel(id: string): Promise<boolean> {
      return cancelMission(id, { store: store(), by: 'telegram' }).ok;
    },

    async status(id: string): Promise<TelegramMissionStatus | null> {
      const s = store();
      const row = s.resolve(id);
      if (!row) return null;
      const sum = summarizeMission(s, row);
      if (!sum) return null;
      const milestones = s.recentEvents(row.id, 5, ['milestone'])
        .map(e => String(e.payload?.title ?? '').trim())
        .filter(Boolean);
      return {
        ...toSummary(sum),
        steps: s.steps(row.id).map(st => ({ title: st.title, status: st.status })),
        milestones,
        pendingApprovals: sum.pendingApprovals.length,
        report: s.get(row.id)?.report ?? undefined,
        error: sum.error ?? undefined,
        costUsd: sum.costUsd,
      };
    },

    async pendingApprovals(): Promise<TelegramMissionApproval[]> {
      return store().listPendingApprovals().map(a => ({
        id: a.id,
        missionId: a.mission_id,
        prompt: a.prompt,
        options: approvalOptions(a),
        category: a.category ?? undefined,
        risk: a.risk ?? undefined,
      }));
    },

    async resolveApproval(id: string, answer: string, by: string): Promise<boolean> {
      return answerApprovalById(id, answer, { store: store(), by }).ok;
    },

    async eventsSince(afterId: number | null): Promise<{ events: TelegramMissionEvent[]; cursor: number }> {
      const s = store();
      if (afterId === null) return { events: [], cursor: s.maxEventId() };
      const events: TelegramMissionEvent[] = [];
      let cursor = afterId;
      for (const ev of s.eventsAfter(afterId, { limit: 200 })) {
        cursor = ev.id;
        const ts = ms(ev.ts);
        if (ev.type === 'status') {
          const to = ev.payload?.to;
          if (typeof to !== 'string' || !NOTIFY_STATUSES.has(to)) continue;
          const m = s.get(ev.missionId);
          events.push({
            id: ev.id, missionId: ev.missionId, type: to, ts,
            data: { status: to, error: ev.payload?.error ?? m?.error ?? undefined, report: (m?.report ?? '').slice(0, 600), goal: m?.goal },
          });
        } else if (ev.type === 'milestone') {
          events.push({ id: ev.id, missionId: ev.missionId, type: 'milestone', ts, data: ev.payload });
        }
      }
      return { events, cursor };
    },
  };
}
