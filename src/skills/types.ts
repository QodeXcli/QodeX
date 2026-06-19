/**
 * Skills extend QodeX with installable, model-invoked capabilities. Unlike custom
 * slash commands (which only fire when the user types `/<name>`), a Skill's
 * name + description is also injected into the system prompt so the model can
 * decide on its own when the task at hand matches.
 *
 * Disk layout (project overrides user):
 *   ~/.qodex/skills/<name>/SKILL.md          (user-global)
 *   <cwd>/.qodex/skills/<name>/SKILL.md      (project-specific)
 *
 * A skill directory contains a SKILL.md plus any reference files the
 * instructions refer to (palette.md, examples/*, scripts/*, etc.). The model
 * pulls the full body via the `use_skill` tool — only the one-line description
 * lives in the system prompt, so even 20 installed skills cost ~1k tokens.
 *
 * SKILL.md frontmatter schema:
 *   name: taste              # required; must match dir name
 *   description: ...         # required; one line shown to the model
 *   version: 0.1.0           # optional
 *   allowed-tools: [...]     # optional; restricts tools for /skill <name> runs
 *   triggers: [...]          # optional; hints for when the model should load
 *   slash-aliases: [...]     # optional; register additional /commands
 *   model: claude-...        # optional; override routed model on explicit run
 *   files: [palette.md, ...] # optional; bundled with use_skill response
 *   author: ...              # optional metadata
 *   source: gh:user/repo     # set by installer, tracks provenance
 */

export interface SkillSpec {
  /** Skill id (kebab-case). Must match the directory name. */
  name: string;
  /** Absolute path of the skill directory. */
  dir: string;
  /** Where the skill was found. project wins on collisions. 'plugin' = imported from a Claude Code plugin / .claude dir. */
  origin: 'project' | 'user' | 'builtin' | 'plugin';
  /** One-line description used for both model awareness and listings. */
  description: string;
  /** Optional semver-like version tag. */
  version?: string;
  /** Full Markdown body (everything after the frontmatter). Loaded lazily. */
  body: string;
  /** When the explicit /skill <name> form runs, the agent gets these tools only. */
  allowedTools?: string[];
  /** Hints for when the skill is relevant (keywords/regex strings). */
  triggers?: string[];
  /** Extra slash command names registered for this skill (/ghost, /taste, etc.). */
  slashAliases?: string[];
  /** Optional model override for explicit /skill runs. */
  model?: string;
  /** Bundled reference files (relative paths inside the skill dir). */
  files?: string[];
  /** Optional author for credit. */
  author?: string;
  /** Provenance (e.g. "local:/path", "gh:user/repo", "npm:pkg"). */
  source?: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  origin: SkillSpec['origin'];
  version?: string;
  enabled: boolean;
  triggers?: string[];
  slashAliases?: string[];
}

export type SkillState = Record<string, { enabled: boolean }>;
