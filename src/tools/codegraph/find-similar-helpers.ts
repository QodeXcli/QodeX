/**
 * `find_similar_helpers` — code-graph-driven detection of NEAR-duplicate helper functions that
 * could be collapsed into one shared helper. Goes beyond exact-duplicate detection (the
 * `consolidate-dupes` maintain scope): it finds functions that were copy-pasted then tweaked —
 * same structure, a different constant or a renamed variable — which exact matching misses.
 *
 * Read-only. Extracting a shared helper changes call sites, so this SURFACES clusters (ranked by
 * how many lines a helper would save) for review — it does not refactor. The judgment (which
 * functions are structurally equivalent despite surface differences) is exactly what a plain agent
 * can't make without the code graph.
 */
import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { extractSymbols } from '../../codegraph/extractor.js';
import { findSimilarHelpers, formatHelperClusters, proposeParameterizedHelper, formatParamProposal, type FunctionUnit } from '../../codegraph/helper-extract.js';

const Args = z.object({
  path: z.string().optional().describe('Restrict the scan to this subdirectory (relative to cwd). Default: whole project.'),
  min_similarity: z.number().min(0.5).max(1).optional().describe('Cluster threshold, 0.5–1. Default 0.82 (near-duplicates). Lower = looser clusters.'),
  include_exact: z.boolean().optional().describe('Include exact (post-normalization) clones too. Default false — those belong to consolidate-dupes.'),
  include_tests: z.boolean().optional().describe('Include test files. Default false (test helpers are often intentionally repetitive).'),
  max_files: z.number().int().min(1).max(50_000).optional().describe('File scan cap. Default 4000.'),
});

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.cache', 'coverage', 'vendor', '.idea']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.php', '.rb', '.go']);
const TEST_RE = /\.(test|spec)\.[jt]sx?$|__tests__\/|\/tests?\/|_test\.py$|test_.*\.py$/;

export class FindSimilarHelpersTool extends Tool<z.infer<typeof Args>> {
  name = 'find_similar_helpers';
  description = 'Find NEAR-duplicate helper functions across the project (copy-pasted-then-tweaked: same structure, different constant/name) that could be collapsed into one shared helper. Goes beyond exact-duplicate detection. Read-only — reports clusters ranked by lines saved, for you to review and extract with a verified PR. The code-graph judgment a plain agent can\'t make.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = Args;

  async execute(args: z.infer<typeof Args>, ctx: ToolContext): Promise<ToolResult> {
    const cwd = ctx.cwd ?? process.cwd();
    const root = args.path ? path.resolve(cwd, args.path) : cwd;
    const maxFiles = args.max_files ?? 4000;

    const units: FunctionUnit[] = [];
    let scanned = 0;
    const stack = [root];
    while (stack.length > 0 && scanned < maxFiles) {
      const dir = stack.pop()!;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (scanned >= maxFiles) break;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          stack.push(path.join(dir, e.name));
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (!SOURCE_EXTS.has(ext)) continue;
          const abs = path.join(dir, e.name);
          const rel = path.relative(cwd, abs);
          if (!args.include_tests && TEST_RE.test(rel)) continue;
          try {
            const stat = await fs.stat(abs);
            if (stat.size > 2_000_000) continue;
            const content = await fs.readFile(abs, 'utf-8');
            scanned++;
            const lines = content.split('\n');
            const symbols = await extractSymbols(abs, content);
            for (const s of symbols) {
              if (s.kind !== 'function' && s.kind !== 'method') continue;
              const body = lines.slice(s.startLine - 1, s.endLine).join('\n');
              units.push({ name: s.name, file: rel, startLine: s.startLine, endLine: s.endLine, body });
            }
          } catch { /* skip unreadable */ }
        }
      }
    }

    const clusters = findSimilarHelpers(units, { minSim: args.min_similarity })
      .filter(c => args.include_exact || !c.exact);

    // v2: for the top clusters, try a mechanical PARAMETERIZE proposal — the concrete shared
    // helper + the exact call each original becomes. Declines (with the reason) when bodies
    // don't align, so a proposal only appears when the consolidation is genuinely mechanical.
    const proposals: string[] = [];
    for (const c of clusters.slice(0, 2)) {
      const bodies = c.members
        .map(m => units.find(u => u.name === m.name && u.file === m.file && u.startLine === m.startLine))
        .filter((u): u is FunctionUnit => !!u)
        .slice(0, 6);
      if (bodies.length < 2) continue;
      const pr = proposeParameterizedHelper(bodies, c.suggestedName);
      if (pr.ok) proposals.push(`For cluster \`${c.suggestedName}\`:\n${formatParamProposal(pr)}`);
    }
    const proposalBlock = proposals.length ? `\n\n${proposals.join('\n\n')}` : '';

    const header = `Scanned ${scanned} file(s), ${units.length} function(s).`;
    return {
      content: `${header}\n\n${formatHelperClusters(clusters)}${proposalBlock}`,
      metadata: {
        filesScanned: scanned,
        functions: units.length,
        clusters: clusters.length,
        totalLinesSaveable: clusters.reduce((a, c) => a + c.estLinesSaved, 0),
        top: clusters.slice(0, 5).map(c => ({ name: c.suggestedName, copies: c.members.length, similarity: c.avgSimilarity, linesSaved: c.estLinesSaved })),
      },
    };
  }
}
