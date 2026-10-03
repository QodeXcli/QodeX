/**
 * `recall_approach` — search QodeX's own history on THIS project (episodes + worklog) for how a
 * similar thing was done before. The "how did we solve auth last time?" tool.
 */
import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../base.js';

const Args = z.object({
  query: z.string().describe('What to recall — e.g. "how did we add auth?" or "pagination approach".'),
  limit: z.number().int().min(1).max(20).optional().describe('Max past approaches to return. Default 5.'),
});

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export class RecallApproachTool extends Tool<z.infer<typeof Args>> {
  name = 'recall_approach';
  description = 'Search YOUR OWN history on this project — solved tasks (episodic memory), the project worklog, AND learned facts — for how a similar thing was done before. Returns a VISUAL comparison: the best-matching approach in full, a diff of how other attempts differed from it (what each added/lacked, which extra files), and the stable core common to all. Use when the user asks "how did we do X before", or before re-solving a recurring task. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, ctx: ToolContext): Promise<ToolResult> {
    const cwd = ctx.cwd ?? process.cwd();
    const { rankApproaches } = await import('../../context/approach-recall.js');
    const { getSessionStore } = await import('../../session/store.js');
    const store = getSessionStore();

    const worklog = (() => {
      try { return store.getWorklog(cwd, 100).map((w: any) => ({ kind: 'worklog' as const, text: w.entry, when: relTime(w.created_at), at: w.created_at, detail: w.kind })); }
      catch { return []; }
    })();
    const episodes = await (async () => {
      try {
        const { readEpisodes } = await import('../../context/episodic-memory.js');
        return (await readEpisodes(cwd)).map(e => ({ kind: 'episode' as const, text: `${e.prompt} ${e.summary}`, when: relTime(e.ts), at: e.ts, files: e.filesChanged, detail: e.summary, verified: e.verified }));
      } catch { return []; }
    })();

    const facts = (() => {
      try { return store.getFactsForCwd(cwd, 200).map((f: string) => ({ kind: 'fact' as const, text: f, when: '', detail: 'fact' })); }
      catch { return []; }
    })();

    // Maintain receipts — verified autonomous work IS history worth recalling, with ground-truth
    // outcomes: opened = proven success (boosted), blocked = the guardrail declined (down-weighted).
    const receipts = await (async () => {
      try {
        const { getScheduleStore } = await import('../../schedule/store.js');
        const { parseMaintainScope } = await import('../../schedule/recipes.js');
        const sched = getScheduleStore();
        const out: { kind: 'receipt'; text: string; when: string; at: string; files?: string[]; detail?: string; verified?: boolean }[] = [];
        for (const s of sched.list().filter((s: any) => s.recipe === 'maintain' && s.cwd === cwd)) {
          const scope = parseMaintainScope(s.prompt).scope;
          for (const r of sched.recentRuns(s.id, 50)) {
            if (!r.receipt) continue;
            try {
              const rc = JSON.parse(r.receipt);
              const files: string[] = Array.isArray(rc.filesChanged) ? rc.filesChanged : [];
              out.push({
                kind: 'receipt', at: r.started_at, when: relTime(r.started_at),
                text: `maintain ${scope}: ${rc.summary || rc.reason || rc.status}`,
                files, detail: scope,
                verified: rc.status === 'opened' ? true : rc.status === 'blocked' || rc.status === 'failed' ? false : undefined,
              });
            } catch { /* skip malformed receipt */ }
          }
        }
        return out;
      } catch { return []; }
    })();

    const matches = rankApproaches(args.query, [...episodes, ...worklog, ...facts, ...receipts], { topK: args.limit ?? 5, nowMs: Date.now(), diversity: 0.35 });

    // Visual comparison for the top approaches (best match + how the others differed + stable
    // core); anything past the visualized window is listed compactly so nothing is hidden.
    const { renderApproachDiffs } = await import('../../context/approach-diff.js');
    const VIZ_K = 4;
    let content = renderApproachDiffs(args.query, matches, { topK: VIZ_K });
    if (matches.length > VIZ_K) {
      const rest = matches.slice(VIZ_K).map(m => `- [${m.when} · ${Math.round(m.score * 100)}%] ${m.text.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
      content += `\n\nAlso similar:\n${rest.join('\n')}`;
    }
    return { content, metadata: { matches: matches.length, episodes: episodes.length, worklog: worklog.length } };
  }
}
