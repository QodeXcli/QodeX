/**
 * `use_skill` — load an installed skill's full instructions into the conversation.
 *
 * Skills are richer than tools: each one is an installed playbook (a SKILL.md +
 * optional reference files). The system prompt advertises every installed
 * skill's name + one-line description; when the model decides one matches, it
 * calls this tool, which returns the full body so the model can follow the
 * playbook on the next turn.
 *
 * Load lazily — only when the current turn matches a skill's description.
 * Loading several skills in one turn is fine but rarely necessary.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getSkill, listSkills } from '../../skills/registry.js';

const UseSkillArgs = z.object({
  name: z.string().min(1).describe(
    'The id of the skill to load (e.g. "taste", "ui-ux-pro-max", "ghost"). ' +
    'Must match one of the skills advertised in the system prompt under "Available Skills".'
  ),
  include_files: z.boolean().optional().describe(
    'If true, also inline the skill\'s bundled reference files (palette.md, examples, etc.). ' +
    'Default true. Set to false to keep the response compact when you only need the main playbook.'
  ),
});

export class UseSkillTool extends Tool<z.infer<typeof UseSkillArgs>> {
  name = 'use_skill';
  description =
    'Load an installed skill\'s full instructions for the current task. Skills are user-installed playbooks (taste, ui-ux-pro-max, ghost, OODA, L99, god-mode, artifacts, etc.) advertised in the system prompt under "Available Skills". When the user\'s request matches a skill\'s description, call this FIRST so you can follow that playbook before editing/answering. Read-only — it just returns text. Returns: the skill\'s full body, plus any bundled reference files unless include_files=false.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = UseSkillArgs;

  async execute(args: z.infer<typeof UseSkillArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const spec = getSkill(args.name);
    if (!spec) {
      const available = listSkills().map(s => s.name);
      const hint = available.length
        ? `Installed skills: ${available.join(', ')}.`
        : 'No skills installed yet.';
      return {
        content: `[ERROR] Unknown skill "${args.name}". ${hint}\n` +
          `To fetch it from GitHub, call install_skill with source="${args.name}" ` +
          `(it resolves the name to a repo automatically), then retry use_skill.`,
        isError: true,
      };
    }

    const parts: string[] = [];
    parts.push(`# Skill: ${spec.name}`);
    if (spec.version) parts.push(`Version: ${spec.version}`);
    parts.push(`Origin: ${spec.origin}`);
    parts.push('');
    parts.push(spec.body);

    const includeFiles = args.include_files !== false;
    if (includeFiles && spec.files?.length) {
      for (const rel of spec.files) {
        const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
        const filePath = path.join(spec.dir, safeRel);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          parts.push('');
          parts.push(`---`);
          parts.push(`## Bundled file: ${safeRel}`);
          parts.push('');
          parts.push(content);
        } catch (e: any) {
          parts.push('');
          parts.push(`(failed to read bundled file ${safeRel}: ${e?.message ?? 'unknown error'})`);
        }
      }
    }

    if (spec.allowedTools?.length) {
      parts.push('');
      parts.push(`---`);
      parts.push(
        `Recommended tools for this skill: ${spec.allowedTools.join(', ')}. ` +
        `Stay within these unless the task obviously needs more.`
      );
    }

    return { content: parts.join('\n') };
  }
}
