/**
 * `mcp_scaffold` — write a complete @modelcontextprotocol/sdk-based server into a
 * target directory. The agent typically calls this after the 4-stage MCP-build
 * conversation (`/mcp-build`): discovery → schema → scaffold (this) → wire+test.
 *
 * Mutating tool: it creates files. We refuse to clobber a non-empty target unless
 * `overwrite=true` is set explicitly.
 */
import { z } from 'zod';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { scaffoldMcpServer } from '../../mcp/scaffold/builder.js';

const McpScaffoldArgs = z.object({
  name: z.string().describe('Server / package name. Lowercase letters, digits, hyphens; must start with a letter (e.g. "weather-mcp").'),
  description: z.string().describe('One-line description for package.json and README.'),
  dir: z.string().optional().describe('Target directory (absolute or relative to cwd). Defaults to ./<name> under cwd.'),
  overwrite: z.boolean().optional().describe('Allow writing into a non-empty target. Default false.'),
  transport: z.enum(['stdio']).optional().describe('Transport. Only "stdio" is supported by the default template.'),
});

type Args = z.infer<typeof McpScaffoldArgs>;

export class McpScaffoldTool extends Tool<Args> {
  name = 'mcp_scaffold';
  description = 'Scaffold a new Model Context Protocol (MCP) server in TypeScript: package.json, tsconfig, src/index.ts + src/tools/example.ts, test, README, .gitignore. Output is ready to npm install + build + start, and includes a YAML snippet to register the server in QodeX (~/.qodex/config.yaml). Mutating: writes files. Refuses non-empty targets unless overwrite=true.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = McpScaffoldArgs;

  async execute(args: Args, ctx: ToolContext): Promise<ToolResult> {
    const dir = path.isAbsolute(args.dir ?? '') ? args.dir! : path.resolve(ctx.cwd, args.dir ?? args.name);

    try {
      const result = await scaffoldMcpServer({
        dir,
        name: args.name,
        description: args.description,
        transport: args.transport ?? 'stdio',
      }, { overwrite: args.overwrite === true });

      const lines = [
        `✓ Scaffolded MCP server "${args.name}" in ${result.dir}`,
        '',
        `Files written (${result.filesWritten.length}):`,
        ...result.filesWritten.map(f => `  - ${f}`),
        '',
        'Next steps:',
        `  cd "${result.dir}"`,
        `  npm install`,
        `  npm run build`,
        `  npm test    # runs the example tool test`,
        `  npm start   # start the MCP server on stdio`,
        '',
        'To wire into QodeX, append this to ~/.qodex/config.yaml:',
        '',
        result.configSnippet,
        'Then restart QodeX or run `/mcp-restart ' + args.name + '` from inside an active session.',
      ];

      return {
        content: lines.join('\n'),
        metadata: { dir: result.dir, files: result.filesWritten.length },
      };
    } catch (e: any) {
      return { content: `[MCP_SCAFFOLD_ERROR] ${e.message}`, isError: true };
    }
  }
}
