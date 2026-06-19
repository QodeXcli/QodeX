/**
 * `install_mcp` — add an MCP server to the user config during a session.
 *
 * Mirrors `install_skill`: the model (or user) names a server — "linear",
 * "sentry", "github" — and this resolves it against the bundled MCP registry
 * and writes the entry into ~/.qodex config. Credentials are NEVER written as
 * literals; the registry entry uses ${ENV_VAR} references, so the user fills
 * the secret in their environment. We surface exactly which env vars are needed.
 *
 * Listing is supported too: source="list" returns the catalog so the model can
 * tell the user what's available.
 *
 * Note: a newly added server isn't live in the CURRENT process — MCP servers
 * are wired at startup. We say so, and tell the user it's ready next launch.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { findMcpSpec, listMcpSpecs } from '../../mcp/registry.js';
import { addServerToConfig, listConfiguredServers } from '../../mcp/config-writer.js';

const Args = z.object({
  source: z.string().describe(
    'MCP server name to add (e.g. "linear", "sentry", "github", "slack"), ' +
    'or "list" to see the catalog of available servers.'
  ),
});

export class InstallMcpTool extends Tool<z.infer<typeof Args>> {
  name = 'install_mcp';
  description =
    'Add an MCP server (connector) to the user config by name — e.g. install_mcp source="linear". ' +
    'Use source="list" to see what is available. Resolves against the bundled MCP registry and ' +
    'writes the config entry (secrets stay as ${ENV_VAR} references, never literals). ' +
    'The server becomes active on the next QodeX launch.';
  isReadOnly = false;
  isDestructive = false; // writes user config only; no project files, no secrets
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, _ctx: ToolContext): Promise<ToolResult> {
    const q = args.source.trim();

    if (q.toLowerCase() === 'list' || q === '') {
      const specs = listMcpSpecs();
      const installed = new Set(await listConfiguredServers().catch((): string[] => []));
      const lines = ['Available MCP servers (install_mcp source="<id>"):', ''];
      for (const s of specs) {
        const mark = installed.has(s.id) ? '✓' : '○';
        lines.push(`  ${mark} ${s.id} — ${s.description}`);
      }
      lines.push('', '✓ = already in your config.');
      return { content: lines.join('\n') };
    }

    const spec = findMcpSpec(q);
    if (!spec) {
      const ids = listMcpSpecs().map(s => s.id).join(', ');
      return {
        content: `[NOT_FOUND] No MCP server named "${q}" in the registry.\nAvailable: ${ids}.\n` +
          `Use install_mcp source="list" for descriptions.`,
        isError: true,
      };
    }

    const already = await listConfiguredServers().catch((): string[] => []);
    if (already.includes(spec.id)) {
      return { content: `MCP server "${spec.id}" is already in your config. It's active on next launch.` };
    }

    let written;
    try {
      written = await addServerToConfig(spec);
    } catch (e: any) {
      return { content: `[ERROR] Couldn't write MCP config: ${e.message}`, isError: true };
    }

    const lines: string[] = [];
    lines.push(`✓ Added MCP server "${written.id}" (${spec.description}) to your config.`);
    if (spec.transport === 'remote' && spec.url) lines.push(`  URL: ${spec.url}`);
    if (spec.command) lines.push(`  Command: ${spec.command}${spec.args ? ' ' + spec.args.join(' ') : ''}`);

    if (spec.credentials && spec.credentials.length > 0) {
      lines.push('', 'Set these environment variables before next launch:');
      for (const c of spec.credentials) {
        lines.push(`  ${c.envVar}${c.optional ? ' (optional)' : ''} — ${c.label}. ${c.hint}`);
      }
    } else if (spec.auth === 'oauth') {
      lines.push('', 'Uses OAuth — you\'ll be prompted to authorize on first use.');
    }
    if (spec.note) lines.push('', spec.note);
    lines.push('', 'The server activates on the next QodeX launch (MCP is wired at startup).');

    return {
      content: lines.join('\n'),
      metadata: { id: written.id, transport: spec.transport },
    };
  }
}
