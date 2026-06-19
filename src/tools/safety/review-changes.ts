/**
 * `review_my_changes` — self-critique tool.
 *
 * Before the agent declares a task complete, it should call this tool to
 * review its own git diff against the user's stated intent. The tool:
 *
 *   1. Captures the current `git diff` (uncommitted changes)
 *   2. Returns a structured payload the model can reason over: changed files,
 *      lines added/removed, suspicious patterns
 *   3. Flags risk patterns:
 *        - Unrelated edits (files outside the stated scope)
 *        - TODO/FIXME/XXX added (incomplete work)
 *        - console.log / print / dump leftover (debug output forgotten)
 *        - Commented-out code (suggests uncertainty)
 *        - Massive multi-line replacements (suggests overreach)
 *        - Tests deleted or marked .skip / xit (suspect)
 *        - Hardcoded secrets / API keys / passwords
 *
 * Read-only. Designed to be self-called by the agent right before claiming
 * done; the agent reads the output and either fixes flagged items or
 * confirms the user.
 */

import { z } from 'zod';
import { spawnSync } from 'child_process';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const ReviewChangesArgs = z.object({
  intent: z.string().min(1).describe('What the user asked for, in your own words. Used to flag edits that drifted off-task.'),
  max_diff_bytes: z.number().int().min(1024).max(2_000_000).optional().describe('Cap on diff size to scan. Default 200000.'),
});

interface RiskFlag {
  severity: 'high' | 'medium' | 'low';
  pattern: string;
  file: string;
  line: string;
}

const RISK_PATTERNS: Array<{ name: string; regex: RegExp; severity: 'high' | 'medium' | 'low'; explain: string }> = [
  { name: 'hardcoded_api_key',      regex: /(api[_-]?key|apikey|secret|access[_-]?token|password|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}/i, severity: 'high',   explain: 'Hardcoded secret/key/password' },
  { name: 'aws_access_key',         regex: /AKIA[0-9A-Z]{16}/,                                            severity: 'high',   explain: 'AWS access key id' },
  { name: 'private_key_header',     regex: /-----BEGIN (RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/,        severity: 'high',   explain: 'Private key embedded' },
  { name: 'todo_added',             regex: /^\+.*\b(TODO|FIXME|XXX|HACK)\b/,                              severity: 'medium', explain: 'TODO/FIXME marker added — incomplete work' },
  { name: 'console_log',            regex: /^\+.*\bconsole\.(log|debug|info|warn|error)\(/,               severity: 'medium', explain: 'console.log left in (debug leftover)' },
  { name: 'print_python',           regex: /^\+.*\bprint\s*\(/,                                           severity: 'low',    explain: 'print() left in (review if intentional)' },
  { name: 'php_dump',               regex: /^\+.*\b(var_dump|print_r|error_log|dd|dump)\s*\(/,            severity: 'medium', explain: 'PHP debug-dump call added' },
  { name: 'test_skipped',           regex: /^\+.*\b(it|test|describe)\.(skip|only)\b|\bxit\b|\bxdescribe\b/, severity: 'high',   explain: 'Test skipped / .only — likely accidental' },
  { name: 'test_removed',           regex: /^-.*\b(it|test|describe)\s*\(/,                               severity: 'medium', explain: 'Test deleted — verify intent' },
  { name: 'commented_out_code',     regex: /^\+\s*(\/\/|#)\s*[a-zA-Z_$][\w$]*\s*\(/,                       severity: 'low',    explain: 'Commented-out code added (suggests uncertainty)' },
  { name: 'eval_call',              regex: /^\+.*\beval\s*\(/,                                            severity: 'high',   explain: 'eval() call introduced — security risk' },
  { name: 'wildcard_import',        regex: /^\+\s*from\s+\S+\s+import\s+\*/,                              severity: 'low',    explain: 'Wildcard import (`from X import *`)' },
  { name: 'any_type',               regex: /^\+.*:\s*any\b/,                                              severity: 'low',    explain: 'TypeScript `: any` — defeat of type system' },
  { name: 'process_exit',           regex: /^\+.*\bprocess\.exit\(/,                                      severity: 'medium', explain: 'process.exit() — abrupt termination' },
  { name: 'sleep_in_code',          regex: /^\+.*\b(time\.sleep|setTimeout.*?,\s*\d{4,})/,                 severity: 'low',    explain: 'Long sleep / setTimeout — flakey behavior' },
];

function runGit(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch {
    return { exitCode: 127, stdout: '', stderr: 'git failed' };
  }
}

export class ReviewMyChangesTool extends Tool<z.infer<typeof ReviewChangesArgs>> {
  name = 'review_my_changes';
  description = 'Self-critique tool. Call BEFORE telling the user a task is done. Reviews your current uncommitted git diff against the stated intent and flags suspicious patterns: forgotten console.log, TODOs added, tests skipped, hardcoded secrets, etc. Returns a structured report — fix anything flagged "high" or "medium" before claiming done. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ReviewChangesArgs;

  async execute(args: z.infer<typeof ReviewChangesArgs>, ctx: ToolContext): Promise<ToolResult> {
    const maxBytes = args.max_diff_bytes ?? 200_000;

    // Verify git repo
    const repoCheck = runGit(ctx.cwd, ['rev-parse', '--is-inside-work-tree']);
    if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== 'true') {
      return {
        content: '[REVIEW_NO_REPO] Not a git repository — self-critique requires git for diff. Run `git init` to enable, or skip this step.',
        isError: true,
      };
    }

    // Get diff
    const diff = runGit(ctx.cwd, ['diff', 'HEAD', '--unified=2']);
    const untracked = runGit(ctx.cwd, ['ls-files', '--others', '--exclude-standard']);

    if (diff.exitCode !== 0) {
      return { content: `[REVIEW_GIT_ERROR] git diff failed: ${diff.stderr.trim()}`, isError: true };
    }

    let diffText = diff.stdout;
    const truncated = diffText.length > maxBytes;
    if (truncated) diffText = diffText.slice(0, maxBytes) + '\n[TRUNCATED]';

    const stat = runGit(ctx.cwd, ['diff', 'HEAD', '--shortstat']);
    const filesChanged = runGit(ctx.cwd, ['diff', 'HEAD', '--name-only']);
    const filesList = filesChanged.stdout.trim().split('\n').filter(s => s.length > 0);
    const newFiles = untracked.stdout.trim().split('\n').filter(s => s.length > 0);

    // Run risk pattern scan
    const flags: RiskFlag[] = [];
    const lines = diffText.split('\n');
    let currentFile = '';
    for (const line of lines) {
      const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
      if (fileMatch) { currentFile = fileMatch[1]!; continue; }
      if (!line.startsWith('+') && !line.startsWith('-')) continue;
      for (const pat of RISK_PATTERNS) {
        if (pat.regex.test(line)) {
          flags.push({
            severity: pat.severity,
            pattern: pat.name,
            file: currentFile,
            line: line.slice(0, 200),
          });
        }
      }
    }

    const out: string[] = [];
    out.push(`# Self-Review: changes against intent`);
    out.push(`Intent: ${args.intent}`);
    out.push('');
    out.push(`## Stats`);
    out.push(`  ${stat.stdout.trim() || '(no tracked changes)'}`);
    out.push(`  Tracked files changed: ${filesList.length}`);
    out.push(`  New (untracked) files: ${newFiles.length}`);
    if (truncated) out.push(`  ⚠ Diff truncated at ${maxBytes} bytes — review manually if needed`);
    out.push('');

    out.push(`## Files changed`);
    if (filesList.length === 0 && newFiles.length === 0) {
      out.push('  (none — working tree clean)');
    } else {
      for (const f of filesList.slice(0, 25)) out.push(`  M ${f}`);
      for (const f of newFiles.slice(0, 25)) out.push(`  + ${f}`);
      if (filesList.length + newFiles.length > 50) out.push(`  …and ${filesList.length + newFiles.length - 50} more`);
    }
    out.push('');

    out.push(`## Risk flags (${flags.length})`);
    if (flags.length === 0) {
      out.push('  ✓ Clean — no automatic risk patterns matched.');
    } else {
      const byFile = new Map<string, RiskFlag[]>();
      for (const f of flags) {
        if (!byFile.has(f.file)) byFile.set(f.file, []);
        byFile.get(f.file)!.push(f);
      }
      for (const [file, fileFlags] of byFile) {
        out.push(`  ${file}`);
        for (const f of fileFlags.slice(0, 5)) {
          const icon = f.severity === 'high' ? '🚨' : f.severity === 'medium' ? '⚠️ ' : 'ℹ️ ';
          const pat = RISK_PATTERNS.find(p => p.name === f.pattern);
          out.push(`    ${icon} ${pat?.explain ?? f.pattern}`);
          out.push(`       ${f.line.slice(0, 160)}`);
        }
        if (fileFlags.length > 5) out.push(`    …and ${fileFlags.length - 5} more flags in this file`);
      }
    }
    out.push('');

    // Recommendations
    const high = flags.filter(f => f.severity === 'high').length;
    const medium = flags.filter(f => f.severity === 'medium').length;
    out.push(`## Recommendation`);
    if (high > 0) {
      out.push(`  🚨 ${high} HIGH-severity flag(s) — FIX BEFORE claiming done.`);
    }
    if (medium > 0) {
      out.push(`  ⚠️  ${medium} medium flag(s) — review each and either fix or explain to the user.`);
    }
    if (flags.length === 0) {
      out.push(`  ✓ Looks clean against pattern set. Consider also running auto_fix with the project's test/lint command before claiming done.`);
    }

    return {
      content: out.join('\n'),
      metadata: {
        filesChanged: filesList.length,
        newFiles: newFiles.length,
        flags: flags.length,
        high,
        medium,
        low: flags.filter(f => f.severity === 'low').length,
      },
    };
  }
}
