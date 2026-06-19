/**
 * Artifact tools — the model-facing surface of the Living Artifact system (Layer 1).
 *
 * These let the model produce a named, versioned, self-contained output instead of
 * dumping code into the chat: `artifact_create` makes v1, `artifact_update` adds a new
 * version (old ones are preserved), `artifact_list` / `artifact_get` browse them, and
 * `artifact_rollback` repoints "current" to an earlier version. Writes go through the
 * journaled transaction, so artifacts are undoable like any other edit.
 *
 * Layer 2 (auto browser preview) and Layer 3 (vision self-correction) will hook onto
 * `artifact_create` / `artifact_update` for web types — but artifacts work fully without
 * them.
 */
import { z } from 'zod';
import { Tool, ToolContext, ToolResult } from '../base.js';
import {
  createArtifact, updateArtifact, listArtifacts, getArtifact, rollbackArtifact,
  isArtifactType, type ArtifactType,
} from '../../artifacts/store.js';

const TYPE_VALUES = ['html', 'react', 'svg', 'markdown', 'vue', 'text'] as const;

const CreateArgs = z.object({
  title: z.string().describe('Human title for the artifact, e.g. "Pricing page" — also seeds its id.'),
  type: z.enum(TYPE_VALUES).describe('Artifact kind: html, react (JSX), svg, markdown, vue, or text.'),
  content: z.string().describe('The full file content of this first version.'),
  note: z.string().optional().describe('Optional note describing this version.'),
});

export class ArtifactCreateTool extends Tool<z.infer<typeof CreateArgs>> {
  name = 'artifact_create';
  description = 'Create a new versioned artifact (a self-contained web page, React component, SVG, or doc the user will keep and iterate on). Returns the artifact id. Prefer this over dumping a large standalone file into chat.';
  argsSchema = CreateArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof CreateArgs>, ctx: ToolContext): Promise<ToolResult> {
    if (!isArtifactType(args.type)) {
      return { content: `Invalid artifact type "${args.type}". Use one of: ${TYPE_VALUES.join(', ')}.`, isError: true };
    }
    const { manifest, absFile } = await createArtifact(
      ctx.cwd,
      { title: args.title, type: args.type as ArtifactType, content: args.content, note: args.note },
      (p, c) => ctx.transaction.write(p, c),
    );
    ctx.emit({ type: 'progress', message: `Created artifact "${manifest.id}" (v1)` });
    return {
      content: `Created artifact "${manifest.id}" (${manifest.type}, v1) at ${absFile}. Use artifact_update with id="${manifest.id}" to revise it.`,
      metadata: { artifactId: manifest.id, version: 1, type: manifest.type, path: absFile },
    };
  }
}

const UpdateArgs = z.object({
  id: z.string().describe('The artifact id returned by artifact_create.'),
  content: z.string().describe('The full file content of the NEW version (not a diff).'),
  note: z.string().optional().describe('What changed in this version.'),
});

export class ArtifactUpdateTool extends Tool<z.infer<typeof UpdateArgs>> {
  name = 'artifact_update';
  description = 'Save a new version of an existing artifact. Previous versions are preserved (use artifact_rollback to go back). Pass the FULL new content, not a diff.';
  argsSchema = UpdateArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof UpdateArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const { manifest, absFile, version } = await updateArtifact(
        ctx.cwd,
        { id: args.id, content: args.content, note: args.note },
        (p, c) => ctx.transaction.write(p, c),
      );
      ctx.emit({ type: 'progress', message: `Updated artifact "${manifest.id}" → v${version}` });
      return {
        content: `Saved "${manifest.id}" v${version} at ${absFile}. It now has ${manifest.versions.length} version(s).`,
        metadata: { artifactId: manifest.id, version, type: manifest.type, path: absFile },
      };
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }
  }
}

const ListArgs = z.object({});

export class ArtifactListTool extends Tool<z.infer<typeof ListArgs>> {
  name = 'artifact_list';
  description = 'List all artifacts in this project with their current version and type.';
  argsSchema = ListArgs;
  isReadOnly = true;
  isDestructive = false;

  async execute(_args: z.infer<typeof ListArgs>, ctx: ToolContext): Promise<ToolResult> {
    const items = await listArtifacts(ctx.cwd);
    if (items.length === 0) return { content: 'No artifacts yet. Create one with artifact_create.' };
    const lines = items.map(a => `- ${a.id} (${a.type}) — "${a.title}", v${a.current} of ${a.versionCount}`);
    return { content: `Artifacts (${items.length}):\n${lines.join('\n')}`, metadata: { count: items.length } };
  }
}

const GetArgs = z.object({
  id: z.string().describe('The artifact id.'),
  version: z.number().int().positive().optional().describe('Version to read (defaults to current).'),
});

export class ArtifactGetTool extends Tool<z.infer<typeof GetArgs>> {
  name = 'artifact_get';
  description = 'Read the content of an artifact version (defaults to the current version).';
  argsSchema = GetArgs;
  isReadOnly = true;
  isDestructive = false;

  async execute(args: z.infer<typeof GetArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const { manifest, version, content } = await getArtifact(ctx.cwd, args.id, args.version);
      return {
        content: `Artifact "${manifest.id}" v${version} (${manifest.type}):\n\n${content}`,
        metadata: { artifactId: manifest.id, version, type: manifest.type },
      };
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }
  }
}

const RollbackArgs = z.object({
  id: z.string().describe('The artifact id.'),
  version: z.number().int().positive().describe('The earlier version number to make current.'),
});

export class ArtifactRollbackTool extends Tool<z.infer<typeof RollbackArgs>> {
  name = 'artifact_rollback';
  description = 'Repoint an artifact\u2019s "current" version to an earlier one. No content is lost; later versions remain in history.';
  argsSchema = RollbackArgs;
  isReadOnly = false;
  isDestructive = false;

  async execute(args: z.infer<typeof RollbackArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const manifest = await rollbackArtifact(ctx.cwd, args.id, args.version, (p, c) => ctx.transaction.write(p, c));
      ctx.emit({ type: 'progress', message: `Rolled "${manifest.id}" back to v${args.version}` });
      return { content: `"${manifest.id}" current version is now v${args.version}.`, metadata: { artifactId: manifest.id, current: args.version } };
    } catch (e: any) {
      return { content: e?.message ?? String(e), isError: true };
    }
  }
}

export const ARTIFACT_TOOLS = [
  ArtifactCreateTool, ArtifactUpdateTool, ArtifactListTool, ArtifactGetTool, ArtifactRollbackTool,
];
