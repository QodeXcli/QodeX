/**
 * `install_skill` — install a skill from GitHub (or local path) during a session.
 *
 * The model calls this when it needs a skill that isn't installed yet. It's the
 * same as running `qodex skill install gh:user/repo` but available as a tool
 * inside the agent loop — so the model can self-provision skills it recognizes
 * it needs without asking the user to run a CLI command.
 *
 * Safety: this only installs into ~/.qodex/skills/ (the user skill dir), never
 * into system or project dirs. It requires git to be on PATH (same as the CLI
 * command). The tool announces what it's installing before doing it, so the
 * user always knows.
 *
 * The model should call this when:
 *   - The user explicitly asks for a skill by name/author that isn't installed
 *   - A use_skill call fails with "Unknown skill" and the name looks like a
 *     GitHub source (e.g. "emilkowalski/skill", "user/repo")
 *   - The task clearly benefits from a skill the model knows exists on GitHub
 *     (e.g. "use the Emil Kowalski style" → install emilkowalski if missing)
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { refreshSkillRegistry } from '../../skills/registry.js';

const Args = z.object({
  source: z.string().describe(
    'A skill name OR a source. ' +
    'NAME: just say what the user asked for — "emil", "shadcn", "tailwind" — ' +
    'and it resolves via the known-skills registry, then GitHub search. ' +
    'SOURCE (explicit): "gh:user/repo", "gh:user/repo@branch", ' +
    '"gh:user/repo@ref#subpath", or "./local/path".'
  ),
  skill_name: z.string().optional().describe(
    'Human-readable name for progress messages (e.g. "emilkowalski"). Optional.'
  ),
  force: z.boolean().optional().describe(
    'Overwrite if already installed. Default false.'
  ),
});

export class InstallSkillTool extends Tool<z.infer<typeof Args>> {
  name = 'install_skill';
  description =
    'Install a skill into the user skill library, BY NAME or by source. ' +
    'When the user says "load/use/install the <name> skill" and it isn\'t installed, ' +
    'call this with source="<name>" — it resolves the name to a GitHub repo automatically ' +
    '(known-skills registry first, then GitHub search). Or pass an explicit "gh:user/repo". ' +
    'Also call this when a use_skill fails with "Unknown skill". ' +
    'After install the skill is immediately available via use_skill.';
  isReadOnly = false;
  isDestructive = false; // installs into ~/.qodex/skills only, no project files touched
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, ctx: ToolContext): Promise<ToolResult> {
    const lines: string[] = [];

    // Resolve a bare NAME (e.g. "emil", "shadcn") to a concrete source.
    // A real source already looks like gh:.. / http.. / ./.. / /.. — leave those.
    let source = args.source.trim();
    const looksLikeSource = /^(gh:|https?:\/\/|git@|\.\/|\.\.\/|\/)/.test(source);
    if (!looksLikeSource) {
      const name = source;
      const { resolveKnownSkill, searchGitHubForSkill } = await import('../../skills/skill-sources.js');
      const known = resolveKnownSkill(name);
      if (known) {
        source = known.source;
        lines.push(`Resolved "${name}" → ${source} (${known.description}).`);
      } else {
        lines.push(`"${name}" isn't a known skill — searching GitHub…`);
        const hit = await searchGitHubForSkill(name);
        if (!hit) {
          return {
            content: lines.concat(
              `Couldn't find a skill named "${name}" on GitHub (no match, or no network).`,
              `If you know the repo, call install_skill with source="gh:owner/repo".`,
            ).join('\n'),
            isError: true,
          };
        }
        source = hit.source;
        lines.push(
          hit.confirmed
            ? `Found ${hit.repo} (has SKILL.md) → installing.`
            : `Best match: ${hit.repo} (couldn't confirm a SKILL.md — will try; install fails cleanly if it isn't a skill).`,
        );
      }
    }

    const label = args.skill_name ?? source;
    lines.push(`Installing skill: ${label} …`);

    const { installAll } = await import('../../skills/bulk-installer.js');
    const result = await installAll(source, {
      force: args.force ?? false,
      maxSkills: 50,
      onProgress: (msg) => lines.push(`  ${msg}`),
    });

    // Refresh registry so new skills are immediately usable.
    try { await refreshSkillRegistry(); } catch { /* non-fatal */ }

    if (result.installed.length > 0) {
      lines.push('');
      lines.push(`✓ Installed ${result.installed.length} skill(s):`);
      for (const s of result.installed) lines.push(`    ● ${s.name}`);
    }
    if (result.skipped.length > 0) {
      lines.push(`↷ Skipped ${result.skipped.length} (already installed)`);
    }
    if (result.failed.length > 0) {
      lines.push(`✗ Failed ${result.failed.length}:`);
      for (const f of result.failed) lines.push(`    ✗ ${f.source}: ${f.error.slice(0, 120)}`);
    }

    const ok = result.installed.length > 0;
    if (ok) {
      lines.push('');
      lines.push(`Skills are now available. Call use_skill name="${result.installed[0]!.name}" to load the first one.`);
    } else if (result.skipped.length > 0) {
      lines.push('');
      const name = args.skill_name?.toLowerCase().replace(/[^a-z0-9-]/g, '-') ?? 'skill';
      lines.push(`Already installed. Call use_skill name="${name}" to use it.`);
    }

    return {
      content: lines.join('\n'),
      isError: !ok && result.skipped.length === 0,
      metadata: {
        installed: result.installed.map(s => s.name),
        failed: result.failed.length,
      },
    };
  }
}
