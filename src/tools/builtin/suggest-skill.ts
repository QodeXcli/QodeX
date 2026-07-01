/**
 * `suggest_skill` — after finishing a task, ask whether the work looks like a REUSABLE pattern
 * worth capturing as a skill, judged from the SHAPE of the change via the code graph. The
 * code-graph-informed answer a generic agent can't give.
 */
import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../base.js';

const Args = z.object({
  task: z.string().describe('What you just did / the task — used to name the candidate skill and judge reusability.'),
  draft: z.boolean().optional().describe('When the shape says the task is a reusable pattern, DRAFT a quarantined candidate skill (default true). Set false to only get the recommendation without writing anything.'),
});

export class SuggestSkillTool extends Tool<z.infer<typeof Args>> {
  name = 'suggest_skill';
  description = 'After completing a task, judge whether it is a REUSABLE pattern worth saving as a skill — using the code graph to read the SHAPE of the change (focused + cohesive in one module = repeatable). When it clearly is, proactively DRAFTS a quarantined candidate skill (provenance:machine, status:candidate) so you only review + promote, never write from scratch. The code-graph-informed judgment a generic agent can\'t give.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, ctx: ToolContext): Promise<ToolResult> {
    const cwd = ctx.cwd ?? process.cwd();

    // Files changed this session (working tree vs HEAD).
    const changedFiles = await (async () => {
      try {
        const { git } = await import('../git/git-runner.js');
        const d = await git(['diff', 'HEAD', '--name-only'], { cwd });
        return d.exitCode === 0 ? d.stdout.split('\n').map(s => s.trim()).filter(Boolean) : [];
      } catch { return []; }
    })();

    const { suggestSkillFromSession, draftCandidateSkill, commonArea } = await import('../../skills/learning/skill-suggest.js');
    const area = commonArea(changedFiles);

    // Cohesion = how concentrated the change is in one module (a code-organization signal), with a
    // best-effort boost when the code graph shows the touched files are import-connected.
    const inArea = changedFiles.filter(f => f.split('/').slice(0, 2).join('/') === area).length;
    let cohesion = changedFiles.length ? inArea / changedFiles.length : 0;
    let touchedSymbols: string[] | undefined;
    try {
      const { getSymbolGraph, dependencyContextFor } = await import('../../context/symbol-graph.js');
      const graph = await getSymbolGraph(cwd, { signal: AbortSignal.timeout(3000) });
      if (graph && changedFiles.length) {
        const deps = dependencyContextFor(graph, changedFiles);
        touchedSymbols = [...new Set(deps.map((d: any) => d.symbol ?? d.name).filter(Boolean))].slice(0, 6);
        // connected cluster (the change's files reference each other) → real reusable pattern
        if (deps.some((d: any) => (d.neighbors ?? d.deps ?? []).length > 0)) cohesion = Math.min(1, cohesion + 0.15);
      }
    } catch { /* graph optional */ }

    const input = { prompt: args.task, changedFiles, cohesion, touchedSymbols };
    const s = suggestSkillFromSession(input);

    // Proactive: when the shape clearly says "reusable pattern", draft the candidate now (quarantined)
    // so the user only reviews + promotes. Skipped if draft:false, or if an identically-named candidate
    // already exists (don't spam duplicates).
    let drafted: string | null = null;
    if (s.worth && args.draft !== false) {
      try {
        const { listCandidates, writeCandidate } = await import('../../skills/learning/candidate-store.js');
        const existing = await listCandidates().catch(() => []);
        if (!existing.some(c => c.name === s.proposedName)) {
          const c = draftCandidateSkill(input, s, new Date().toISOString());
          await writeCandidate(c);
          drafted = c.name;
        }
      } catch { /* drafting is best-effort — the recommendation still stands */ }
    }

    const head = s.worth
      ? (drafted
        ? `💡 Drafted a candidate skill: "${drafted}" (quarantined)\n   ${s.reason}\n   → review with \`qodex skill candidates\`, promote with \`qodex skill curate\`.`
        : `💡 Worth saving as a skill: "${s.proposedName}"\n   ${s.reason}\n   → review with \`qodex skill candidates\`, then \`qodex skill curate\`.`)
      : `No skill suggested. ${s.reason}`;
    return { content: head, metadata: { worth: s.worth, score: s.score, proposedName: s.proposedName, area: s.area, changedFiles: changedFiles.length, drafted: !!drafted } };
  }
}
