/**
 * QodeX special MCP tools.
 *
 * Beyond re-exposing the generic registry, these wrap QodeX's signature
 * capabilities as first-class MCP tools an editor can call directly:
 *
 *   qodex_hybrid_search  — the BM25+embedding hybrid retrieval (+ optional
 *                          cross-encoder rerank). "Find the code relevant to X"
 *                          with QodeX's retrieval quality, from inside Cursor/Zed.
 *   qodex_critic_review  — hand a code change to the local Senior-QA critic for
 *                          a logic/spec review before the editor commits.
 *   qodex_sandbox_run    — run a shell command in QodeX's isolated execution
 *                          sandbox (code_run), returning stdout/stderr safely.
 *
 * Each returns an MCPToolResult. They reuse existing modules (retrieval,
 * critic, code_run) so there's one implementation of each capability, not two.
 */

import type { MCPToolDef, MCPToolResult } from '../types.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { QodexConfig } from '../../config/defaults.js';

export interface SpecialTool {
  def: MCPToolDef;
  handler: (args: unknown) => Promise<MCPToolResult>;
}

interface Deps {
  registry: ToolRegistry;
  config: QodexConfig;
  cwd: string;
}

function textResult(text: string, isError = false): MCPToolResult {
  return { content: [{ type: 'text', text }], isError };
}

export function buildQodexMcpTools(deps: Deps): SpecialTool[] {
  return [
    hybridSearchTool(deps),
    criticReviewTool(deps),
    sandboxRunTool(deps),
  ];
}

function hybridSearchTool(deps: Deps): SpecialTool {
  return {
    def: {
      name: 'qodex_hybrid_search',
      description:
        'Search the project with QodeX\'s hybrid retrieval (BM25 keyword + semantic ' +
        'embeddings, optional cross-encoder rerank). Returns the most relevant files ' +
        'with their best-matching lines. Use to find code relevant to a task.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for (natural language or symbol).' },
          maxFiles: { type: 'number', description: 'Max files to return. Default 8.' },
        },
        required: ['query'],
      },
    },
    handler: async (args: any) => {
      const query = String(args?.query ?? '').trim();
      if (!query) return textResult('[ERROR] query is required', true);
      const { retrieveRelevantFiles, formatRetrievalBlock } = await import('../../context/retrieval.js');
      const ctxCfg = (deps.config as any).context ?? {};
      const files = await retrieveRelevantFiles(deps.cwd, query, {
        maxFiles: args?.maxFiles ?? 8,
        embeddingModel: ctxCfg.embeddingModel,
        rerank: ctxCfg.rerank === true,
        rerankModel: ctxCfg.rerankModel,
        signal: AbortSignal.timeout(15_000),
      });
      if (!files || files.length === 0) {
        return textResult('No relevant files found (or the embedding index isn\'t built — run /index in QodeX).');
      }
      return textResult(formatRetrievalBlock(files));
    },
  };
}

function criticReviewTool(deps: Deps): SpecialTool {
  return {
    def: {
      name: 'qodex_critic_review',
      description:
        'Review a code change with QodeX\'s local Senior-QA critic — finds logic bugs, ' +
        'boundary errors, unhandled cases, and project-convention mismatches BEFORE you ' +
        'commit. Returns a pass/fail verdict with specific findings.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What the change was supposed to accomplish.' },
          files: {
            type: 'array',
            description: 'The changed files to review.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        },
        required: ['task', 'files'],
      },
    },
    handler: async (args: any) => {
      const task = String(args?.task ?? '');
      const files = Array.isArray(args?.files) ? args.files : [];
      if (files.length === 0) return textResult('[ERROR] files array is required', true);
      const { buildCriticPrompt, parseCriticVerdict } = await import('../../agent/critic.js');
      const { ModelRouter } = await import('../../llm/router.js');
      const router = new ModelRouter(deps.config);
      await router.initialize();
      const { system, user } = buildCriticPrompt({ task, files });
      const route = router.route('reflection', 0, {});
      const stream = route.provider.complete({
        model: route.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      let text = '';
      for await (const ev of stream) if (ev.type === 'text_delta') text += ev.delta ?? '';
      const verdict = parseCriticVerdict(text);
      const lines = [
        `Verdict: ${verdict.pass ? 'PASS ✓' : 'BLOCKED ✗'}`,
        ...verdict.findings.map(f => `  [${f.severity}] ${f.location ? f.location + ': ' : ''}${f.issue}`),
      ];
      return textResult(lines.join('\n'), !verdict.pass);
    },
  };
}

function sandboxRunTool(deps: Deps): SpecialTool {
  return {
    def: {
      name: 'qodex_sandbox_run',
      description:
        'Run a shell command in QodeX\'s isolated execution sandbox (restricted FS writes, ' +
        'optional network denial, hard timeout). Returns stdout/stderr. Safer than running ' +
        'arbitrary commands directly on the host.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
          timeout_ms: { type: 'number', description: 'Max run time (ms). Default 30000.' },
          network: { type: 'boolean', description: 'Allow network. Default false in server mode.' },
        },
        required: ['command'],
      },
    },
    handler: async (args: any) => {
      const command = String(args?.command ?? '').trim();
      if (!command) return textResult('[ERROR] command is required', true);
      const { makeServerToolContext } = await import('./tool-context.js');
      const ctx = await makeServerToolContext(deps.cwd, deps.config);
      try {
        // Reuse the registered code_run / shell tool through the registry so the
        // same sandboxing applies. Prefer code_run if present, else shell.
        const toolName = deps.registry.has('code_run') ? 'code_run' : 'shell';
        const callArgs = toolName === 'code_run'
          ? { language: 'bash', code: command, timeout_ms: args?.timeout_ms ?? 30_000, network: args?.network ?? false }
          : { command, timeout_ms: args?.timeout_ms ?? 30_000 };
        const r = await deps.registry.execute(toolName, callArgs, ctx);
        return textResult(typeof r.content === 'string' ? r.content : JSON.stringify(r.content), r.isError ?? false);
      } finally {
        await ctx._cleanup?.();
      }
    },
  };
}
