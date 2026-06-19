/**
 * Pure parsers that normalize the output of common type-checkers / linters into a
 * single `Diagnostic` shape. No I/O, no spawning — the tool wrapper runs the command
 * and feeds the captured text/JSON here, so every format is unit-testable on its own.
 *
 * WHY THIS MATTERS (local-first specific): tree-sitter (what QodeX already has) gives
 * the model *syntax*, not *types*. A weaker local model can't reliably infer that a
 * symbol is misspelled or a type is wrong — but a language server / type-checker can
 * say so precisely. Feeding those ground-truth diagnostics back to the model closes
 * the loop and disproportionately helps models that are worse at holding type state
 * in their head. This is the same signal `auto_fix` gives for tests, at the type level.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  file: string;
  line: number;
  col?: number;
  severity: Severity;
  message: string;
  code?: string;
}

/** `tsc` default (non-JSON) output:
 *    src/app.ts(12,5): error TS2304: Cannot find name 'foo'.
 *  Also tolerates the no-position form: `error TS18003: ...`. */
export function parseTsc(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    const m = re.exec(line);
    if (!m) continue;
    out.push({
      file: m[1]!,
      line: parseInt(m[2]!, 10),
      col: parseInt(m[3]!, 10),
      severity: m[4] === 'warning' ? 'warning' : 'error',
      code: m[5],
      message: m[6]!.trim(),
    });
  }
  return out;
}

/** ESLint JSON formatter (`eslint -f json`): array of file results. severity 2=error, 1=warning. */
export function parseEslintJson(json: string): Diagnostic[] {
  const data = JSON.parse(json) as Array<{
    filePath: string;
    messages: Array<{ line?: number; column?: number; severity: number; message: string; ruleId?: string | null }>;
  }>;
  const out: Diagnostic[] = [];
  for (const file of data ?? []) {
    for (const msg of file.messages ?? []) {
      out.push({
        file: file.filePath,
        line: msg.line ?? 0,
        col: msg.column,
        severity: msg.severity === 2 ? 'error' : 'warning',
        message: msg.message,
        code: msg.ruleId ?? undefined,
      });
    }
  }
  return out;
}

/** Ruff JSON (`ruff check --output-format json`): flat array of violations. */
export function parseRuffJson(json: string): Diagnostic[] {
  const data = JSON.parse(json) as Array<{
    filename: string;
    location?: { row?: number; column?: number };
    code?: string | null;
    message: string;
  }>;
  return (data ?? []).map(d => ({
    file: d.filename,
    line: d.location?.row ?? 0,
    col: d.location?.column,
    severity: 'error' as Severity,
    message: d.message,
    code: d.code ?? undefined,
  }));
}

/** Pyright JSON (`pyright --outputjson`): { generalDiagnostics: [...] }. */
export function parsePyrightJson(json: string): Diagnostic[] {
  const data = JSON.parse(json) as {
    generalDiagnostics?: Array<{
      file: string;
      severity: string;
      message: string;
      rule?: string;
      range?: { start?: { line?: number; character?: number } };
    }>;
  };
  return (data.generalDiagnostics ?? []).map(d => ({
    file: d.file,
    // Pyright lines/characters are 0-based — normalize to 1-based for humans/editors.
    line: (d.range?.start?.line ?? 0) + 1,
    col: (d.range?.start?.character ?? 0) + 1,
    severity: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info',
    message: d.message,
    code: d.rule,
  }));
}

/** `go vet` / generic compiler output:  path/file.go:12:5: message  (col optional). */
export function parseLineColMessage(output: string, defaultSeverity: Severity = 'error'): Diagnostic[] {
  const out: Diagnostic[] = [];
  const withCol = /^(.+?):(\d+):(\d+):\s+(.*)$/;
  const noCol = /^(.+?):(\d+):\s+(.*)$/;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('vet:')) continue;
    let m = withCol.exec(line);
    if (m) {
      out.push({ file: m[1]!, line: parseInt(m[2]!, 10), col: parseInt(m[3]!, 10), severity: defaultSeverity, message: m[4]!.trim() });
      continue;
    }
    m = noCol.exec(line);
    if (m) {
      out.push({ file: m[1]!, line: parseInt(m[2]!, 10), severity: defaultSeverity, message: m[3]!.trim() });
    }
  }
  return out;
}

/** Render diagnostics into a compact, model-friendly report grouped by file. */
export function formatDiagnostics(diags: Diagnostic[], opts: { checker: string; maxResults: number }): string {
  const errors = diags.filter(d => d.severity === 'error').length;
  const warnings = diags.filter(d => d.severity === 'warning').length;

  if (diags.length === 0) {
    return `# Diagnostics (${opts.checker})\n\n✓ No problems found. Clean.`;
  }

  const capped = diags.slice(0, opts.maxResults);
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of capped) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file)!.push(d);
  }

  const lines: string[] = [];
  lines.push(`# Diagnostics (${opts.checker})`);
  lines.push(`${errors} error(s), ${warnings} warning(s)${diags.length > capped.length ? ` — showing first ${capped.length}` : ''}`);
  lines.push('');
  for (const [file, ds] of byFile) {
    lines.push(`## ${file}`);
    for (const d of ds) {
      const pos = d.col != null ? `${d.line}:${d.col}` : `${d.line}`;
      const sev = d.severity.toUpperCase();
      const code = d.code ? ` [${d.code}]` : '';
      lines.push(`  ${pos}  ${sev}${code}  ${d.message}`);
    }
    lines.push('');
  }
  lines.push('Fix the errors above (read the file at the reported line, edit, then re-run diagnostics to confirm).');
  return lines.join('\n');
}

/**
 * Parse `php -l` (lint) output. Success is "No syntax errors detected in <file>".
 * Errors look like:
 *   PHP Parse error:  syntax error, unexpected '}' in /path/file.php on line 42
 *   Parse error: syntax error, unexpected end of file in /path/file.php on line 88
 * `php -l` reports at most ONE (the first) syntax error per file.
 */
export function parsePhpLint(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /(?:PHP\s+)?(?:Parse|Fatal)\s+error:\s*(.+?)\s+in\s+(.+?)\s+on\s+line\s+(\d+)/i;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line || /^No syntax errors detected/i.test(line)) continue;
    const m = re.exec(line);
    if (m) {
      out.push({
        file: m[2]!,
        line: parseInt(m[3]!, 10),
        col: 1,
        severity: 'error',
        message: m[1]!.trim(),
        code: 'php-syntax',
      });
    }
  }
  return out;
}
