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
  description = 'Search YOUR OWN history on this project — solved tasks (episodic memory), the project worklog, AND learned facts — for how a similar thing was done before. Use when the user asks "how did we do X before", or before re-solving a recurring task, to reuse the proven approach (and see which files it touched). Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, ctx: ToolContext): Promise<ToolResult> {
    const cwd = ctx.cwd ?? process.cwd();
    const { rankApproaches, formatApproaches } = await import('../../context/approach-recall.js');
    const { getSessionStore } = await import('../../session/store.js');
    const store = getSessionStore();

    const worklog = (() => {
      try { return store.getWorklog(cwd, 100).map((w: any) => ({ kind: 'worklog' as const, text: w.entry, when: relTime(w.created_at), at: w.created_at, detail: w.kind })); }
      catch { return []; }
    })();
    const episodes = await (async () => {
      try {
        const { readEpisodes } = await import('../../context/episodic-memory.js');
        return (await readEpisodes(cwd)).map(e => ({ kind: 'episode' as const, text: `${e.prompt} ${e.summary}`, when: relTime(e.ts), at: e.ts, files: e.filesChanged, detail: e.summary }));
      } catch { return []; }
    })();

    const facts = (() => {
      try { return store.getFactsForCwd(cwd, 200).map((f: string) => ({ kind: 'fact' as const, text: f, when: '', detail: 'fact' })); }
      catch { return []; }
    })();

    const matches = rankApproaches(args.query, [...episodes, ...worklog, ...facts], { topK: args.limit ?? 5, nowMs: Date.now(), diversity: 0.35 });
    return { content: formatApproaches(args.query, matches), metadata: { matches: matches.length, episodes: episodes.length, worklog: worklog.length } };
  }
}
