/**
 * `suggest_skill` — after finishing a task, ask whether the work looks like a REUSABLE pattern
 * worth capturing as a skill, judged from the SHAPE of the change via the code graph. The
 * code-graph-informed answer a generic agent can't give.
 */
import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../base.js';

const Args = z.object({
  task: z.string().describe('What you just did / the task — used to name the candidate skill and judge reusability.'),
});

export class SuggestSkillTool extends Tool<z.infer<typeof Args>> {
  name = 'suggest_skill';
  description = 'After completing a task, judge whether it is a REUSABLE pattern worth saving as a skill — using the code graph to read the SHAPE of the change (focused + cohesive in one module = repeatable). Returns a recommendation + a proposed name. Read-only; suggests, does not capture (use `qodex skill candidates`/`curate` to act).';
  isReadOnly = true;
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

    const { suggestSkillFromSession, commonArea } = await import('../../skills/learning/skill-suggest.js');
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

    const s = suggestSkillFromSession({ prompt: args.task, changedFiles, cohesion, touchedSymbols });
    const head = s.worth
      ? `💡 Worth saving as a skill: "${s.proposedName}"\n   ${s.reason}\n   → review with \`qodex skill candidates\`, then \`qodex skill curate\`.`
      : `No skill suggested. ${s.reason}`;
    return { content: head, metadata: { worth: s.worth, score: s.score, proposedName: s.proposedName, area: s.area, changedFiles: changedFiles.length } };
  }
}
