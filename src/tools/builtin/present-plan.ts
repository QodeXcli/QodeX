import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const StepSchema = z.object({
  action: z.enum(['read', 'edit', 'create', 'delete', 'shell', 'verify']).describe('Type of action'),
  target: z.string().describe('File path, command, or symbol affected'),
  rationale: z.string().describe('Why this step is needed'),
});

const ArgsSchema = z.object({
  goal: z.string().describe('Restatement of the user goal in 1 sentence'),
  steps: z.array(StepSchema).describe('Ordered list of steps to execute'),
  risks: z.array(z.string()).optional().describe('Known risks or unknowns'),
  estimated_changes: z.number().int().optional().describe('Approximate number of files that will be modified'),
});

// Module-level state for the planner to retrieve the plan after execution
let lastPlan: z.infer<typeof ArgsSchema> | null = null;
export function consumeLastPlan(): z.infer<typeof ArgsSchema> | null {
  const p = lastPlan;
  lastPlan = null;
  return p;
}

export class PresentPlanTool extends Tool<z.infer<typeof ArgsSchema>> {
  name = 'present_plan';
  description = 'Submit a structured plan for the user to review. ONLY available in plan mode. Call this once you have a complete plan — it ends the plan phase.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ArgsSchema;

  async execute(args: z.infer<typeof ArgsSchema>, _ctx: ToolContext): Promise<ToolResult> {
    lastPlan = args;
    const lines: string[] = [`Goal: ${args.goal}`, '', 'Steps:'];
    for (let i = 0; i < args.steps.length; i++) {
      const s = args.steps[i]!;
      lines.push(`  ${i + 1}. [${s.action.toUpperCase()}] ${s.target}`);
      lines.push(`     → ${s.rationale}`);
    }
    if (args.risks && args.risks.length > 0) {
      lines.push('', 'Risks:');
      for (const r of args.risks) lines.push(`  - ${r}`);
    }
    if (args.estimated_changes !== undefined) {
      lines.push('', `Estimated file changes: ${args.estimated_changes}`);
    }
    return {
      content: lines.join('\n'),
      metadata: { plan: args },
    };
  }
}
