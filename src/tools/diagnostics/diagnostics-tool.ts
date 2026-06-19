/**
 * `diagnostics` — run the project's type-checker / linter and report ground-truth
 * problems (type errors, undefined names, lint violations) back to the agent.
 *
 * Complements tree-sitter (syntax) and auto_fix (tests) with the *type* layer. Auto-
 * detects the right checker from project files, or the caller can name one. The command
 * set is FIXED (the model only picks from an enum), so this stays safe to auto-run.
 *
 * Shares its checker registry (detect/run/parse specs) with the agent loop's auto-verify
 * gate via ./checkers.ts — one source of truth.
 */

import { z } from 'zod';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { formatDiagnostics, type Diagnostic } from './parsers.js';
import {
  CHECKERS, runChecker, checkerText, detectProjectFiles, pickChecker,
  type CheckerSpec,
} from './checkers.js';

const DiagnosticsArgs = z.object({
  checker: z.enum(['auto', 'tsc', 'eslint', 'ruff', 'pyright', 'govet', 'cargo']).optional()
    .describe('Which checker to run. Default "auto" — picks the right one from project files (tsconfig→tsc, go.mod→go vet, etc.).'),
  path: z.string().optional().describe('Project subdirectory to check. Defaults to cwd.'),
  max_results: z.number().int().min(1).max(500).optional().describe('Cap on diagnostics shown. Default 50.'),
  timeout_ms: z.number().int().min(5000).max(600_000).optional().describe('Per-run timeout. Default 120000.'),
});

export class DiagnosticsTool extends Tool<z.infer<typeof DiagnosticsArgs>> {
  name = 'diagnostics';
  description = 'Run the project\'s type-checker / linter (tsc, eslint, ruff, pyright, go vet, cargo check) and report type errors and lint problems with file:line. This is the TYPE-level ground truth tree-sitter can\'t give you — use it after edits to catch type errors before running tests, and to verify a fix actually type-checks. Auto-detects the checker from project files. Read-only (no code is modified).';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = DiagnosticsArgs;

  async execute(args: z.infer<typeof DiagnosticsArgs>, ctx: ToolContext): Promise<ToolResult> {
    const root = args.path ? path.resolve(ctx.cwd, args.path) : ctx.cwd;
    const maxResults = args.max_results ?? 50;
    const timeoutMs = args.timeout_ms ?? 120_000;
    const want = args.checker ?? 'auto';

    const files = await detectProjectFiles(root);

    let spec: CheckerSpec | undefined;
    if (want !== 'auto') {
      spec = CHECKERS.find(c => c.id === want);
    } else {
      spec = pickChecker(files);
    }

    if (!spec) {
      return {
        content: `[DIAGNOSTICS_NO_CHECKER] No supported checker detected in ${root}. ` +
          `Looked for: tsconfig.json (tsc), pyproject.toml/requirements.txt (ruff/pyright), ` +
          `go.mod (go vet), Cargo.toml (cargo), eslint config (eslint). ` +
          `Pass checker="tsc" (or another) explicitly if the project uses one without a standard config file.`,
        isError: true,
      };
    }

    const res = await runChecker(spec.argv, root, timeoutMs, ctx.signal);

    if (res.spawnError || res.code === 127) {
      const bin = spec.argv[0] === 'npx' ? spec.argv[2] : spec.argv[0];
      return {
        content: `[DIAGNOSTICS_TOOL_MISSING] Could not run '${spec.id}': ${res.spawnError ?? 'command not found'}. ` +
          `Install it (e.g. \`${bin}\`) or choose a different checker. ` +
          `tsc/eslint come from your project's devDependencies (\`npm i\`); ruff/pyright via pip; go/cargo with their toolchains.`,
        isError: true,
      };
    }

    const text = checkerText(spec, res);

    let diags: Diagnostic[];
    try {
      diags = spec.parse(text);
    } catch (e: any) {
      const raw = (text || res.stderr || res.stdout || '').slice(0, 4000);
      return {
        content: `[DIAGNOSTICS_PARSE_NOTE] Ran ${spec.id} (exit ${res.code}) but couldn't parse structured output: ${e?.message}. Raw output:\n\n${raw}`,
        isError: res.code !== 0,
      };
    }

    return {
      content: formatDiagnostics(diags, { checker: spec.id, maxResults }),
      isError: false,
      metadata: { checker: spec.id, total: diags.length, errors: diags.filter(d => d.severity === 'error').length, exitCode: res.code },
    };
  }
}
