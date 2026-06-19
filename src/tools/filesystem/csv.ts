/**
 * `csv_read` and `csv_write` tools — pure-Node CSV handling.
 *
 * Real use cases for Hamed's businesses:
 *   - sg-commerce-pro: Amazon order/return export CSVs
 *   - ChinPost: cargo manifests, shipment lists
 *   - Seven Gum: marketing analytics exports
 *
 * Implementation choices:
 *   - RFC 4180 quoting (double-quote escape via "" — the standard form)
 *   - Auto-detect delimiter from header line (comma, semicolon, tab, pipe)
 *   - First row treated as headers by default (configurable)
 *   - Returns array-of-objects for structured access by the agent
 *   - Truncates output to 100 rows by default to keep context manageable;
 *     for analysis on bigger files, the agent should use `bash` (awk, csvkit)
 *     or process via `code_run`
 *
 * Why no `csv-parse` dependency: a 200-line implementation does the job for
 * 99% of business CSVs. Edge cases (multi-line quoted fields with embedded
 * commas + newlines) are handled. The very rare files this can't parse are
 * better handled with `code_run` + Python's `csv` module anyway.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

/** Detect the most likely delimiter by counting candidates in the header line. */
function detectDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const count = (headerLine.split(d).length - 1);
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parse CSV per RFC 4180. Handles:
 *   - Quoted fields with embedded delimiter, embedded "", and embedded newlines
 *   - CRLF, LF, CR line endings
 *   - Optional BOM at file start
 *   - Empty trailing fields (preserved)
 */
function parseCSV(text: string, delimiter: string): string[][] {
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const len = text.length;

  while (i < len) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"' && field === '') {
        // Start of quoted field
        inQuotes = true;
        i++;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
        i++;
      } else if (ch === '\r' || ch === '\n') {
        // End of row
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        if (ch === '\r' && text[i + 1] === '\n') i += 2;
        else i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  // Trailing record without newline
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Quote a CSV field per RFC 4180 if it contains special chars. */
function quoteField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

const CsvReadArgs = z.object({
  path: z.string().min(1).describe('Path to a CSV file.'),
  delimiter: z.string().optional().describe('Field delimiter. Auto-detected from header if omitted. Use "\\t" for TSV.'),
  has_header: z.boolean().optional().describe('First row is headers. Default true.'),
  max_rows: z.number().int().min(1).max(10_000).optional().describe('Max data rows to return. Default 100.'),
  start_row: z.number().int().min(0).optional().describe('0-indexed start row (after header). Default 0.'),
  columns: z.array(z.string()).optional().describe('Optional list of column names to keep. Other columns dropped. Use for very wide CSVs.'),
});

export class CsvReadTool extends Tool<z.infer<typeof CsvReadArgs>> {
  name = 'csv_read';
  description = 'Read a CSV/TSV file into structured rows. Auto-detects delimiter. Returns formatted output with column summaries + first N rows as JSON-like records. Use for Amazon reports, cargo manifests, marketing exports. For big files use start_row to page through. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = CsvReadArgs;

  async execute(args: z.infer<typeof CsvReadArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const text = await fs.readFile(args.path, 'utf-8');
      // Sniff delimiter from first line if not given
      const firstNL = text.search(/[\r\n]/);
      const headerLine = firstNL === -1 ? text : text.slice(0, firstNL);
      const delim = args.delimiter ?? detectDelimiter(headerLine);

      const allRows = parseCSV(text, delim);
      if (allRows.length === 0) return { content: `[CSV_EMPTY] ${args.path} has no rows.` };

      const hasHeader = args.has_header !== false;
      const headers = hasHeader ? allRows[0]! : allRows[0]!.map((_, i) => `col${i}`);
      const dataRows = hasHeader ? allRows.slice(1) : allRows;

      const startRow = args.start_row ?? 0;
      const maxRows = args.max_rows ?? 100;
      const slice = dataRows.slice(startRow, startRow + maxRows);

      // Column filter
      let cols = headers;
      let colIndices = headers.map((_, i) => i);
      if (args.columns && args.columns.length > 0) {
        const wanted = new Set(args.columns);
        colIndices = headers.map((h, i) => wanted.has(h) ? i : -1).filter(i => i !== -1);
        cols = colIndices.map(i => headers[i]!);
      }

      // Build records
      const records = slice.map(r => {
        const obj: Record<string, string> = {};
        for (let j = 0; j < cols.length; j++) {
          obj[cols[j]!] = r[colIndices[j]!] ?? '';
        }
        return obj;
      });

      const lines: string[] = [];
      lines.push(`CSV: ${args.path}`);
      lines.push(`Delimiter: ${delim === '\t' ? '\\t (tab)' : delim}`);
      lines.push(`Total rows: ${dataRows.length}${args.max_rows && dataRows.length > args.max_rows ? ' (showing first ' + maxRows + ')' : ''}`);
      lines.push(`Columns (${headers.length}): ${headers.join(', ')}`);
      if (args.columns) lines.push(`Filtered to: ${cols.join(', ')}`);
      lines.push('');
      lines.push(`Rows ${startRow + 1}-${startRow + slice.length}:`);
      lines.push(JSON.stringify(records, null, 2));
      return {
        content: lines.join('\n'),
        metadata: { totalRows: dataRows.length, returnedRows: slice.length, columns: headers, delimiter: delim },
      };
    } catch (e: any) {
      return { content: `[CSV_ERROR] ${e?.message ?? String(e)}`, isError: true };
    }
  }
}

const CsvWriteArgs = z.object({
  path: z.string().min(1).describe('Output path (.csv).'),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('Array of records. Each must be a flat object. Keys define columns.'),
  delimiter: z.string().optional().describe('Field delimiter. Default ",". Use "\\t" for TSV.'),
  columns: z.array(z.string()).optional().describe('Column order. Defaults to keys of first row.'),
  append: z.boolean().optional().describe('Append rather than overwrite. Header is NOT re-written when appending.'),
});

export class CsvWriteTool extends Tool<z.infer<typeof CsvWriteArgs>> {
  name = 'csv_write';
  description = 'Write structured records to a CSV/TSV file. Pass `rows` as array of flat objects. Quoting is automatic per RFC 4180. Use `append: true` to add to existing files (header skipped).';
  isReadOnly = false;
  isDestructive = false; // creates/extends file but doesn't delete
  argsSchema = CsvWriteArgs;

  async execute(args: z.infer<typeof CsvWriteArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const delim = args.delimiter ?? ',';
      const append = args.append ?? false;
      const first = args.rows[0];
      const columns = args.columns ?? (first ? Object.keys(first) : []);
      if (columns.length === 0) return { content: '[CSV_WRITE_ERROR] No columns specified and no rows to infer from.', isError: true };

      const lines: string[] = [];
      if (!append) {
        lines.push(columns.map(c => quoteField(c, delim)).join(delim));
      }
      for (const row of args.rows) {
        const vals = columns.map(c => {
          const v = row[c];
          if (v === null || v === undefined) return '';
          return quoteField(String(v), delim);
        });
        lines.push(vals.join(delim));
      }
      const output = lines.join('\n') + '\n';
      if (append) {
        await fs.appendFile(args.path, output, 'utf-8');
      } else {
        await fs.writeFile(args.path, output, 'utf-8');
      }
      return {
        content: `Wrote ${args.rows.length} row(s) to ${args.path}${append ? ' (appended)' : ''}\nColumns: ${columns.join(', ')}`,
        metadata: { rowsWritten: args.rows.length, columns, append },
      };
    } catch (e: any) {
      return { content: `[CSV_WRITE_ERROR] ${e?.message ?? String(e)}`, isError: true };
    }
  }
}
