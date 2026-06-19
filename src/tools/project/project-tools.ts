import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getSessionStore, type WorklogKind } from '../../session/store.js';

/**
 * Project memory tools. The project is the working directory (it already scopes
 * sessions + facts in SessionStore); these add a human-readable, cross-session
 * worklog so a session tomorrow knows what was done today and continues.
 *
 *  - project_log    : append one accomplishment/decision/blocker/note.
 *  - project_recall : read back the worklog (also auto-injected at session start
 *                     via getProjectBriefingFact, so recall is the explicit form).
 */

const LogArgs = z.object({
  entry: z.string().min(1).describe('One concise sentence describing what was accomplished, decided, or blocked. e.g. "Added SP-API price-monitor in collector/ with 6h cron".'),
  kind: z.enum(['work', 'decision', 'blocker', 'note']).optional().describe("Type of entry. 'work' (default) = something done; 'decision' = a choice + rationale; 'blocker' = something stuck; 'note' = context to remember."),
});

export class ProjectLogTool extends Tool<z.infer<typeof LogArgs>> {
  name = 'project_log';
  description = 'Record a completed unit of work (or a decision/blocker/note) in the current project\'s persistent memory, so the NEXT session knows it was done and can continue. Call this when you finish a meaningful piece of work — a feature, fix, refactor, or decision — not for trivial steps. One concise entry each. Persists across sessions, scoped to this directory.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = LogArgs;

  async execute(a: z.infer<typeof LogArgs>, ctx: ToolContext): Promise<ToolResult> {
    const kind = (a.kind ?? 'work') as WorklogKind;
    try {
      getSessionStore().addWorklogEntry(ctx.cwd, ctx.sessionId ?? null, a.entry, kind);
    } catch (e: any) {
      return { content: `Could not write to project memory: ${e?.message ?? e}`, isError: true };
    }
    return { content: `Logged to project memory (${kind}): ${a.entry}` };
  }
}

const RecallArgs = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('How many recent worklog entries to return. Default 20.'),
});

export class ProjectRecallTool extends Tool<z.infer<typeof RecallArgs>> {
  name = 'project_recall';
  description = 'Read what was done in THIS project in earlier sessions — the persistent worklog — so you can continue without redoing work. The same brief is injected automatically at the start of a session in a known project; call this to re-read it or pull more history. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = RecallArgs;

  async execute(a: z.infer<typeof RecallArgs>, ctx: ToolContext): Promise<ToolResult> {
    const brief = getSessionStore().getProjectBriefingFact(ctx.cwd, a.limit ?? 20);
    if (!brief) {
      return {
        content:
          'No project memory yet for this directory. Define a project with the /project command, and record work with project_log as you go — it will be here next session.',
      };
    }
    return { content: brief };
  }
}
