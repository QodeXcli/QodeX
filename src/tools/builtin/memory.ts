/**
 * `remember` tool — persist a fact about the current project.
 *
 * Use cases:
 *   - "User prefers Persian comments in code"
 *   - "This project uses Vite, not webpack"
 *   - "The API key lives in .env under SERVICE_API_KEY"
 *   - "The 'Checkout' flow lives in src/features/checkout"
 *
 * Facts are stored per-cwd in ~/.qodex/sessions.db and auto-included in the
 * system prompt of every future session that starts in the same directory.
 * Distinct from QODEX.md (which is the user's curated, version-controlled rules)
 * — `remember` is the AGENT's scratchpad for things it learns mid-conversation.
 *
 * Companion: `forget` tool removes facts.
 *
 * Best practice for the agent: only call `remember` for things that will
 * matter on a FUTURE session. Things relevant only to the current turn should
 * just stay in the conversation; persisting them adds noise.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getSessionStore } from '../../session/store.js';

const RememberArgs = z.object({
  fact: z.string().min(3).max(500).describe(
    'A concise fact worth remembering for future sessions. ' +
    'Example: "Build command is `npm run build:prod`, NOT `npm run build`." ' +
    'Or a decision/change you made: "Switched auth to JWT in src/auth.ts; sessions table now unused."'
  ),
  scope: z.enum(['project', 'user']).optional().describe(
    "Where the fact applies. 'project' (default): this codebase only — build commands, conventions, " +
    "decisions and code changes made here, debugging findings. 'user': YOU-the-person preferences that " +
    "apply in EVERY project — e.g. \"prefers Persian comments\", \"always run tests before saying done\", " +
    "\"likes gradient/modern UI\". Use 'user' only for durable personal preferences, not project facts."
  ),
});

export class RememberTool extends Tool<z.infer<typeof RememberArgs>> {
  name = 'remember';
  description = 'Persist a fact across QodeX sessions, auto-included in the system prompt next time. scope:"project" (default) is tied to this cwd — use it to record durable decisions, code changes, debugging findings, build commands, conventions, file locations. scope:"user" is global across all projects — use it for the user\'s personal preferences. Use SPARINGLY: only things that will matter on FUTURE sessions; transient task details should stay in conversation.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = RememberArgs;

  async execute(args: z.infer<typeof RememberArgs>, ctx: ToolContext): Promise<ToolResult> {
    const cwd = ctx.cwd ?? process.cwd();
    const scope = args.scope ?? 'project';
    getSessionStore().addFact(ctx.sessionId, cwd, args.fact, scope);
    const { exportMemory } = await import('../../context/memory-mirror.js');
    await exportMemory(cwd); // keep the human-readable MEMORY.md mirror in sync (best-effort)
    const where = scope === 'user' ? 'all projects (user memory)' : cwd;
    return { content: `Remembered for ${where}:\n  ${args.fact}` };
  }
}

const RecallArgs = z.object({
  query: z.string().optional().describe('Full-text search remembered facts by relevance (e.g. "build command", "deploy key"). Omit to list the most recent. Use this to find a specific older fact instead of dumping everything.'),
  limit: z.number().int().min(1).max(100).optional().describe('Max facts to return. Default 20.'),
  scope: z.enum(['project', 'user', 'all']).optional().describe(
    "Which facts to search/list: 'all' (default) shows user + project, 'project' only this cwd, 'user' only global preferences."
  ),
});

export class RecallTool extends Tool<z.infer<typeof RecallArgs>> {
  name = 'recall';
  description = 'Search or list facts persisted via `remember`. Pass `query` to full-text search by relevance; omit it to list the most recent. By default covers both global user preferences and this project\'s facts. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = RecallArgs;

  async execute(args: z.infer<typeof RecallArgs>, ctx: ToolContext): Promise<ToolResult> {
    const cwd = ctx.cwd ?? process.cwd();
    const limit = args.limit ?? 20;
    const scope = args.scope ?? 'all';
    const q = args.query?.trim();
    const store = getSessionStore();
    const get = (s: 'user' | 'project') => q ? store.searchFacts(q, s, cwd, limit) : store.getFactsByScope(s, cwd, limit);
    const sections: string[] = [];
    if (scope === 'all' || scope === 'user') {
      const u = get('user');
      if (u.length) sections.push(`User memory (all projects) — ${u.length}:\n${u.map(f => '  - ' + f).join('\n')}`);
    }
    if (scope === 'all' || scope === 'project') {
      const p = get('project');
      if (p.length) sections.push(`Project memory (${cwd}) — ${p.length}:\n${p.map(f => '  - ' + f).join('\n')}`);
    }
    if (sections.length === 0) {
      return { content: q ? `No facts matching "${q}"${scope === 'all' ? '' : ` in ${scope}`}.` : `No ${scope === 'all' ? '' : scope + ' '}facts stored yet.` };
    }
    return { content: (q ? `🔎 Search "${q}":\n\n` : '') + sections.join('\n\n') };
  }
}

const ForgetArgs = z.object({
  fact_contains: z.string().optional().describe('Delete facts containing this substring. If omitted, all facts in the chosen scope are deleted (requires the `all` flag).'),
  all: z.boolean().optional().describe('Explicit confirmation flag for clearing ALL facts in the scope.'),
  scope: z.enum(['project', 'user']).optional().describe("Which scope to forget from: 'project' (default, this cwd) or 'user' (global preferences)."),
});

export class ForgetTool extends Tool<z.infer<typeof ForgetArgs>> {
  name = 'forget';
  description = 'Remove persisted facts. Specify `fact_contains` to target specific facts, or `all: true` to clear the scope. Use `scope:"user"` to forget a global preference, otherwise it targets this project. Use when a fact is outdated or wrong.';
  isReadOnly = false;
  isDestructive = true; // can wipe useful state — flag for permission system
  argsSchema = ForgetArgs;

  async execute(args: z.infer<typeof ForgetArgs>, ctx: ToolContext): Promise<ToolResult> {
    const cwd = ctx.cwd ?? process.cwd();
    const scope = args.scope ?? 'project';
    if (!args.fact_contains && !args.all) {
      return {
        content: '[FORGET_NEEDS_TARGET] Pass either `fact_contains: "<substring>"` to target specific facts, or `all: true` to clear everything in this scope.',
        isError: true,
      };
    }
    const store = getSessionStore();
    const db = (store as any).db as { prepare: (sql: string) => any };
    // User facts live under the '*' sentinel cwd; project facts under the real cwd.
    const scopeWhere = scope === 'user' ? `scope = 'user'` : `cwd = ? AND scope = 'project'`;
    const scopeArgs = scope === 'user' ? [] : [cwd];
    const label = scope === 'user' ? 'user memory' : cwd;
    const { exportMemory } = await import('../../context/memory-mirror.js');
    if (args.all) {
      const result = db.prepare(`DELETE FROM session_facts WHERE ${scopeWhere}`).run(...scopeArgs);
      await exportMemory(cwd); // keep the MEMORY.md mirror in sync
      return { content: `Forgot ${result.changes} fact(s) from ${label}.` };
    }
    const result = db.prepare(`DELETE FROM session_facts WHERE ${scopeWhere} AND fact LIKE ?`).run(...scopeArgs, `%${args.fact_contains}%`);
    await exportMemory(cwd); // keep the MEMORY.md mirror in sync
    return { content: `Forgot ${result.changes} fact(s) matching "${args.fact_contains}" from ${label}.` };
  }
}
