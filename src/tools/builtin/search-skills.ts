/**
 * `search_skills` — find an installed skill by keyword/meaning.
 *
 * When many skills are installed (> ~14), the system prompt lists only their
 * names + short summaries to keep context lean. This tool lets the model recover
 * the full picture for a specific need: it scores installed skills against the
 * query (name match weighted highest, then triggers, then description) and
 * returns the best handful with their full descriptions, so the model can then
 * `use_skill name="<id>"` on the right one.
 *
 * Read-only, instant (pure in-memory scan of the registry). No model, no I/O.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { searchInstalledSkills } from '../../skills/registry.js';

const SearchSkillsArgs = z.object({
  query: z.string().min(2).describe('What you need help with, in a few words. Examples: "write tests first", "debug systematically", "make a powerpoint", "review code".'),
  limit: z.number().int().min(1).max(20).optional().describe('Max results. Default 8.'),
});

export class SearchSkillsTool extends Tool<z.infer<typeof SearchSkillsArgs>> {
  name = 'search_skills';
  description = 'Find an installed skill by keyword or meaning. Use when many skills are installed and you need to locate the right playbook for the current task. Returns matching skill names + descriptions; follow up with use_skill to load one. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = SearchSkillsArgs;

  async execute(args: z.infer<typeof SearchSkillsArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const results = searchInstalledSkills(args.query, args.limit ?? 8);
    if (results.length === 0) {
      return { content: `No installed skill matches "${args.query}". Use the roster in the system prompt, or install one with \`qodex skill install\`.` };
    }
    const lines = [`# Skills matching "${args.query}"`, ''];
    for (const r of results) {
      lines.push(`- **${r.name}** — ${r.description}`);
    }
    lines.push('');
    lines.push(`Load the best fit with \`use_skill name="<id>"\`.`);
    return { content: lines.join('\n'), metadata: { matchCount: results.length } };
  }
}
