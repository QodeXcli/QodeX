import { Tool, type ToolContext, type ToolResult } from './base.js';
import type { ToolSchema } from '../llm/types.js';
import { coerceArgsToSchema, type JsonSchemaNode } from '../llm/constrained.js';
import { ReadFileTool } from './filesystem/read.js';
import { WriteFileTool } from './filesystem/write.js';
import { ARTIFACT_TOOLS } from './artifacts/artifact-tools.js';
import { EditTextTool } from './filesystem/edit.js';
import { MultiEditTool } from './filesystem/multi-edit.js';
import { MultiFileEditTool } from './filesystem/multi-file-edit.js';
import { PdfReadTool } from './filesystem/pdf-read.js';
import { CsvReadTool, CsvWriteTool } from './filesystem/csv.js';
import { XlsxReadTool } from './filesystem/xlsx.js';
import { LsTool } from './filesystem/ls.js';
import { GlobTool } from './filesystem/glob.js';
import { GrepTool } from './filesystem/grep.js';
import { BashTool } from './shell/bash.js';
import { CodeRunTool } from './shell/code-run.js';
import { EditSymbolTool } from './ast/edit-symbol.js';
import { TodoWriteTool, TodoReadTool } from './builtin/todo.js';
import { ProjectLogTool, ProjectRecallTool } from './project/project-tools.js';
import { PresentPlanTool } from './builtin/present-plan.js';
import { UseSkillTool } from './builtin/use-skill.js';
import { SearchSkillsTool } from './builtin/search-skills.js';
import { DataFlowTool } from './codegraph/data-flow-tool.js';
import { OrchestrateTool } from './builtin/orchestrate.js';
import { FanoutTool } from './builtin/fanout.js';
import { InstallSkillTool } from './builtin/install-skill.js';
import { InstallMcpTool } from './builtin/install-mcp.js';
import {
  CodeGraphFindSymbolTool,
  CodeGraphSearchSymbolsTool,
  CodeGraphListSymbolsTool,
  CodeGraphStatsTool,
  CodeGraphFindCallersTool,
  CodeGraphFindReferencesTool,
  CodeGraphExplainSymbolTool,
} from '../codegraph/tools.js';
import { ProjectOverviewTool } from './codegraph/project-overview.js';
import { AnalyzeImpactTool } from './codegraph/analyze-impact.js';
import { FindDeadCodeTool } from './codegraph/find-dead-code.js';
import { SafeRenameTool, SafeDeleteFileTool } from './codegraph/safe-refactor.js';
import { ReviewMyChangesTool } from './safety/review-changes.js';
import { SmartDiffTool } from './codegraph/smart-diff.js';
import { ExplainCodebaseTool, SuggestImprovementsTool } from './codegraph/quality.js';
import { HttpRequestTool } from './web/http-request.js';
import { DbSchemaTool, DbQueryTool } from './database/db-tools.js';
import { WpFindHookTool, WpListHooksTool } from './wordpress/hooks.js';
import { DetectFrontendStackTool } from './frontend/detect-stack.js';
import { AnalyzeDesignSystemTool, FindUiComponentsTool, DesignAuditTool } from './frontend/design-tools.js';
import { PrintLayoutEngineTool } from './frontend/print-layout.js';
import { SemanticSearchTool } from './codegraph/semantic-search.js';
import { GitStatusTool } from './git/status.js';
import { GitDiffTool } from './git/diff.js';
import { GitLogTool } from './git/log.js';
import { GitBranchTool } from './git/branch.js';
import { GitCommitTool } from './git/commit.js';
import { GitCreatePrTool } from './git/create-pr.js';
import { GenerateReleaseNotesTool } from './git/release-notes.js';
import { McpScaffoldTool } from './mcp-builder/scaffold-tool.js';
import { WebSearchTool } from './web/web-search.js';
import { WebFetchTool } from './web/web-fetch.js';
import { NetworkCheckTool } from './web/network-check.js';
import { SeoAuditTool } from './web/seo-audit.js';
import { VisionAnalyzeTool } from './vision/vision-analyze.js';
import {
  ComputerUseScreenshotTool,
  ComputerUseClickTool,
  ComputerUseTypeTool,
  ComputerUseKeyTool,
  ComputerUseActiveWindowTool,
  ComputerUseListWindowsTool,
} from './computer/use.js';
import {
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserFillTool,
  BrowserScreenshotTool,
  BrowserConsoleTool,
  BrowserEvaluateTool,
  BrowserGetTextTool,
  BrowserWaitForTool,
  BrowserCloseTool,
} from './browser/tools.js';
import {
  DevServerStartTool,
  DevServerLogTool,
  DevServerStopTool,
  DevServerListTool,
} from './browser/dev-server.js';
import { TaskTool } from './builtin/task.js';
import { GatherTool } from './builtin/gather.js';
import { AutoFixTool } from './builtin/auto-fix.js';
import { DiagnosticsTool } from './diagnostics/diagnostics-tool.js';
import { RememberTool, RecallTool, ForgetTool } from './builtin/memory.js';
import { RecallApproachTool } from './builtin/recall-approach.js';
import { SuggestSkillTool } from './builtin/suggest-skill.js';
import { AddProviderTool } from './builtin/add-provider.js';
// v1.40 — infrastructure tool groups
import { NetworkOptimizeTool } from './network/network-optimize.js';
import { DockerPsTool, DockerLogsTool, DockerInspectTool, DockerExecTool, DockerBuildTool, DockerComposeTool } from './docker/docker-tools.js';
import { OpenApiDigestTool } from './api/openapi-digest.js';
import { BackendRoutemapTool } from './backend/route-map.js';
import { MediaProbeTool, MediaTransformTool } from './media/ffmpeg-tools.js';
import { S3SyncTool, CiStatusTool } from './cloud/cloud-tools.js';
import {
  BackgroundJobStartTool,
  BackgroundJobStatusTool,
  BackgroundJobLogTool,
  BackgroundJobWaitTool,
  BackgroundJobListTool,
  BackgroundJobCancelTool,
} from './builtin/background-jobs.js';
import { logger } from '../utils/logger.js';

export interface ToolExecutionMode {
  mode: 'normal' | 'plan' | 'subagent';
  allowedTools?: string[];
  blockedTools?: string[];
}

/**
 * Expand user-config tool patterns into concrete tool names. Supports exact names
 * and trailing-`*` prefix patterns (`docker_*`, `browser_*`). Core tools the agent
 * cannot function without are never expandable — blocking them via config would
 * brick every task, so they're filtered out here regardless of pattern.
 *
 * Why this exists (perf): every tool schema is serialized into EVERY request. With
 * ~109 tools that's a large fixed token payload per iteration; letting the user
 * disable groups they never use (docker/cloud/media on a frontend project) directly
 * shrinks per-iteration prompt size. Pure — unit-testable without the registry.
 */
const NEVER_BLOCK = new Set([
  'shell', 'read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep',
]);
export function expandToolPatterns(patterns: string[], allNames: string[]): string[] {
  const out = new Set<string>();
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) continue;
    if (p.endsWith('*')) {
      const prefix = p.slice(0, -1);
      if (!prefix) continue; // bare "*" would block everything — refuse
      for (const n of allNames) if (n.startsWith(prefix)) out.add(n);
    } else if (allNames.includes(p)) {
      out.add(p);
    }
  }
  for (const core of NEVER_BLOCK) out.delete(core);
  return [...out].sort();
}

export class ToolRegistry {
  private tools = new Map<string, Tool<any>>();

  /**
   * Tool-name aliases. Models trained on other agents (Claude Code, Cursor,
   * Aider, OpenHands…) reach for names we don't use — most commonly `bash` and
   * `run` for our `shell` tool. Rather than returning "Unknown tool" and burning
   * an iteration on a reasonable guess, we map the common synonyms to the real
   * tool. Aliases are resolved on lookup only; they are NOT added to the schema
   * list, so the model still sees exactly one canonical name per tool (keeping
   * the tool-schema prefix stable for prompt caching).
   */
  private static readonly ALIASES: Record<string, string> = {
    bash: 'shell',
    sh: 'shell',
    run: 'shell',
    run_command: 'shell',
    run_terminal_cmd: 'shell',
    execute_command: 'shell',
    terminal: 'shell',
    shell_command: 'shell',
    cmd: 'shell',
  };

  /** Resolve an incoming tool name to a registered one, applying aliases. */
  private resolveName(name: string): string {
    if (this.tools.has(name)) return name;
    const alias = ToolRegistry.ALIASES[name];
    if (alias && this.tools.has(alias)) return alias;
    return name; // unknown — caller reports the error with the original name
  }

  constructor() {
    this.registerBuiltins();
  }

  private registerBuiltins(): void {
    const builtins: Tool<any>[] = [
      new ReadFileTool(),
      new WriteFileTool(),
      new EditTextTool(),
      new EditSymbolTool(),
      new MultiEditTool(),
      new MultiFileEditTool(),
      new PdfReadTool(),
      new CsvReadTool(),
      new CsvWriteTool(),
      new XlsxReadTool(),
      ...ARTIFACT_TOOLS.map(T => new T()),
      new LsTool(),
      new GlobTool(),
      new GrepTool(),
      new BashTool(),
      new CodeRunTool(),
      new TodoWriteTool(),
      new TodoReadTool(),
      new PresentPlanTool(),
      new UseSkillTool(),
      new SearchSkillsTool(),
      new DataFlowTool(),
      new OrchestrateTool(),
      new FanoutTool(),
      new InstallSkillTool(),
      new InstallMcpTool(),
      new CodeGraphFindSymbolTool(),
      new CodeGraphSearchSymbolsTool(),
      new CodeGraphListSymbolsTool(),
      new CodeGraphFindCallersTool(),
      new CodeGraphFindReferencesTool(),
      new CodeGraphExplainSymbolTool(),
      new CodeGraphStatsTool(),
      // v1.10 — understanding tools
      new ProjectOverviewTool(),
      new AnalyzeImpactTool(),
      // v1.11 — quality + refactor-safety tools
      new FindDeadCodeTool(),
      new SafeRenameTool(),
      new SafeDeleteFileTool(),
      // v1.12 — self-critique
      new ReviewMyChangesTool(),
      // v1.13 — power tools
      new SmartDiffTool(),
      new ExplainCodebaseTool(),
      new SuggestImprovementsTool(),
      new HttpRequestTool(),
      new DbSchemaTool(),
      new DbQueryTool(),
      new WpFindHookTool(),
      new WpListHooksTool(),
      // v1.14 — frontend excellence
      new DetectFrontendStackTool(),
      new AnalyzeDesignSystemTool(),
      new FindUiComponentsTool(),
      new DesignAuditTool(),
      new PrintLayoutEngineTool(),
      // v1.15 — semantic search
      new SemanticSearchTool(),
      new GitStatusTool(),
      new GitDiffTool(),
      new GitLogTool(),
      new GitBranchTool(),
      new GitCommitTool(),
      new GitCreatePrTool(),
      new GenerateReleaseNotesTool(),
      new McpScaffoldTool(),
      new WebSearchTool(),
      new WebFetchTool(),
      new NetworkCheckTool(),
      new SeoAuditTool(),
      new VisionAnalyzeTool(),
      new ComputerUseScreenshotTool(),
      new ComputerUseClickTool(),
      new ComputerUseTypeTool(),
      new ComputerUseKeyTool(),
      new ComputerUseActiveWindowTool(),
      new ComputerUseListWindowsTool(),
      new BrowserNavigateTool(),
      new BrowserClickTool(),
      new BrowserFillTool(),
      new BrowserScreenshotTool(),
      new BrowserConsoleTool(),
      new BrowserEvaluateTool(),
      new BrowserGetTextTool(),
      new BrowserWaitForTool(),
      new BrowserCloseTool(),
      new DevServerStartTool(),
      new DevServerLogTool(),
      new DevServerStopTool(),
      new DevServerListTool(),
      new TaskTool(),
      new GatherTool(),
      new AutoFixTool(),
      // v1.16 — type-level ground truth (LSP/checker diagnostics)
      new DiagnosticsTool(),
      new RememberTool(),
      new RecallTool(),
      new RecallApproachTool(),
      new SuggestSkillTool(),
      new ForgetTool(),
      new AddProviderTool(),
      new ProjectLogTool(),
      new ProjectRecallTool(),
      new BackgroundJobStartTool(),
      new BackgroundJobStatusTool(),
      new BackgroundJobLogTool(),
      new BackgroundJobWaitTool(),
      new BackgroundJobListTool(),
      new BackgroundJobCancelTool(),
      // v1.40 — infrastructure tool groups (full-stack: network, docker, api, backend, media, cloud)
      new NetworkOptimizeTool(),
      new DockerPsTool(),
      new DockerLogsTool(),
      new DockerInspectTool(),
      new DockerExecTool(),
      new DockerBuildTool(),
      new DockerComposeTool(),
      new OpenApiDigestTool(),
      new BackendRoutemapTool(),
      new MediaProbeTool(),
      new MediaTransformTool(),
      new S3SyncTool(),
      new CiStatusTool(),
    ];
    for (const tool of builtins) {
      this.tools.set(tool.name, tool);
    }
  }

  register(tool: Tool<any>): void {
    this.tools.set(tool.name, tool);
  }

  /** Remove a tool by name. Returns true if it existed. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Remove every tool whose name starts with the given prefix. Returns count removed. */
  unregisterByPrefix(prefix: string): number {
    let count = 0;
    for (const name of Array.from(this.tools.keys())) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
        count++;
      }
    }
    return count;
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(this.resolveName(name));
  }

  has(name: string): boolean {
    return this.tools.has(this.resolveName(name));
  }

  getSchemas(mode: ToolExecutionMode): ToolSchema[] {
    const filtered = this.filterByMode(mode);
    // Two-bucket deterministic sort:
    //   1. "Common" tools first, in a fixed hand-picked order. LLMs pay more attention
    //      to tools at the top of the list — putting bash, read_file, write_file, etc.
    //      first significantly improves tool-call accuracy on smaller models like
    //      Qwen 2.5 Coder, where a flood of code_graph_* tools at the top was burying
    //      the basics.
    //   2. Everything else alphabetical.
    //
    // Order within each bucket is still deterministic, which preserves the byte-identical
    // tool-schema prefix needed for prompt caching (Ollama, vLLM, Anthropic cache).
    //
    // The COMMON list is intentionally short and stable — adding tools here breaks
    // cached prefixes for users, so keep changes deliberate.
    const COMMON_PRIORITY = [
      'shell', 'read_file', 'write_file', 'edit_file', 'multi_edit', 'edit_symbol',
      'ls', 'glob', 'grep', 'todo_write', 'todo_read',
    ];
    const priorityIndex = new Map(COMMON_PRIORITY.map((name, i) => [name, i]));

    return filtered
      .map(t => t.schema())
      .sort((a, b) => {
        const aPri = priorityIndex.get(a.function.name);
        const bPri = priorityIndex.get(b.function.name);
        // Both in priority list: order by priority index
        if (aPri !== undefined && bPri !== undefined) return aPri - bPri;
        // Only A in priority list: A comes first
        if (aPri !== undefined) return -1;
        if (bPri !== undefined) return 1;
        // Neither in priority list: alphabetical
        return a.function.name.localeCompare(b.function.name);
      });
  }

  filterByMode(mode: ToolExecutionMode): Tool<any>[] {
    let tools = Array.from(this.tools.values());

    if (mode.mode === 'plan') {
      // Only read-only + plan-specific tools
      tools = tools.filter(t => t.isReadOnly || t.name === 'present_plan' || t.name === 'todo_write' || t.name === 'todo_read');
    } else if (mode.mode === 'subagent') {
      // Exclude every sub-agent-spawning tool (no recursion) + present_plan.
      const noRecursion = new Set(['task', 'gather', 'orchestrate', 'fanout', 'present_plan']);
      tools = tools.filter(t => !noRecursion.has(t.name));
    } else {
      // Normal mode: exclude present_plan (only used in plan mode)
      tools = tools.filter(t => t.name !== 'present_plan');
    }

    if (mode.allowedTools) {
      tools = tools.filter(t => mode.allowedTools!.includes(t.name));
    }
    if (mode.blockedTools) {
      tools = tools.filter(t => !mode.blockedTools!.includes(t.name));
    }

    return tools;
  }

  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(this.resolveName(name));
    if (!tool) {
      // Suggest the closest known tool name to nudge the model onto the right one.
      const known = Array.from(this.tools.keys());
      const guess = known.find(k => k.includes(name) || name.includes(k));
      const hint = guess ? ` Did you mean "${guess}"?` : ` Use one of the listed tools (e.g. "shell" for commands).`;
      return { content: `[ERROR] Unknown tool: ${name}.${hint}`, isError: true };
    }

    // Validate args. Two normalization passes BEFORE zod (schema stays strict, so the
    // JSON schema the model sees is unchanged):
    //   1. tool.coerceArgs  — tool-specific fixups (e.g. todo_write's stringy ids).
    //   2. coerceArgsToSchema — generic, schema-guided repair of unambiguous type
    //      mistakes ("5"→5, JSON-string→array, "true"→true). Backend-agnostic; turns
    //      a class of would-be ARGUMENT_VALIDATION_ERRORs into successful calls.
    let parsed: any;
    try {
      const jsonSchema = tool.schema().function.parameters as JsonSchemaNode;
      parsed = tool.argsSchema.parse(coerceArgsToSchema(tool.coerceArgs(args), jsonSchema));
    } catch (e: any) {
      const errMsg = e.errors
        ? e.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`).join('; ')
        : e.message;
      return {
        content: `[ARGUMENT_VALIDATION_ERROR] ${errMsg}\nProvided args: ${JSON.stringify(args)}\nFix your tool arguments and try again.`,
        isError: true,
      };
    }

    logger.debug('Executing tool', { name, args: parsed });

    try {
      const result = await tool.execute(parsed, ctx);
      return result;
    } catch (e: any) {
      return {
        content: `[TOOL_ERROR] ${name} failed: ${e.message}\nReview the error and try a different approach.`,
        isError: true,
      };
    }
  }

  isReadOnly(name: string): boolean {
    return this.tools.get(this.resolveName(name))?.isReadOnly ?? false;
  }

  list(): Tool<any>[] {
    return Array.from(this.tools.values());
  }
}

let _registry: ToolRegistry | null = null;
export function getRegistry(): ToolRegistry {
  if (!_registry) _registry = new ToolRegistry();
  return _registry;
}
