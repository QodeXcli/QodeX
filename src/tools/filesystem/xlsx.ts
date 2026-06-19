/**
 * `xlsx_read` tool — Excel file reading.
 *
 * Use cases (Hamed's businesses):
 *   - Amazon settlement statements (always XLSX with multiple sheets)
 *   - Seller Central inventory reports
 *   - sg-commerce-pro bulk product imports
 *   - ChinPost shipping rate tables from carriers
 *
 * Why optional dep: `xlsx` package is ~3MB and most QodeX users won't need it.
 * `optionalDependencies` lets users opt in with `npm install xlsx`.
 *
 * If the user calls this tool without xlsx installed, they get a clear error
 * with the install command. No silent fallback to "try parsing as text" —
 * that would give garbage output and waste time.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import { Tool, type ToolContext, type ToolResult } from '../base.js';

const XlsxReadArgs = z.object({
  path: z.string().min(1).describe('Path to an .xlsx or .xls file.'),
  sheet: z.union([z.string(), z.number()]).optional().describe('Sheet name or 0-indexed number. Default: first sheet.'),
  max_rows: z.number().int().min(1).max(10_000).optional().describe('Max data rows. Default 100.'),
  start_row: z.number().int().min(0).optional().describe('0-indexed start row (after header). Default 0.'),
  has_header: z.boolean().optional().describe('First row is headers. Default true.'),
  list_sheets: z.boolean().optional().describe('If true, list all sheets and their dimensions without reading data.'),
});

async function loadXlsx(): Promise<any> {
  try {
    // @ts-ignore — optional dep
    return await import('xlsx');
  } catch (e) {
    throw new Error(
      'xlsx package is not installed. Run:\n' +
      '  npm install xlsx\n' +
      '(optional dependency to keep base install small)',
    );
  }
}

export class XlsxReadTool extends Tool<z.infer<typeof XlsxReadArgs>> {
  name = 'xlsx_read';
  description = 'Read an Excel (.xlsx/.xls) workbook. Returns sheet data as structured records. Use list_sheets=true first on unfamiliar files to see what sheets exist. Read-only. Requires `npm install xlsx` (optional dependency).';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = XlsxReadArgs;

  async execute(args: z.infer<typeof XlsxReadArgs>, _ctx: ToolContext): Promise<ToolResult> {
    let XLSX: any;
    try {
      XLSX = await loadXlsx();
    } catch (e: any) {
      return { content: `[XLSX_ERROR] ${e.message}`, isError: true };
    }

    try {
      const buf = await fs.readFile(args.path);
      const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });

      if (args.list_sheets) {
        const sheets = wb.SheetNames.map((name: string) => {
          const ws = wb.Sheets[name];
          const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1');
          const rows = range.e.r - range.s.r + 1;
          const cols = range.e.c - range.s.c + 1;
          return `  - "${name}"  ${rows}r × ${cols}c`;
        });
        return {
          content: `Workbook: ${args.path}\nSheets (${wb.SheetNames.length}):\n${sheets.join('\n')}\n\nUse sheet="<name>" to read a specific one.`,
          metadata: { sheets: wb.SheetNames },
        };
      }

      // Pick sheet
      let sheetName: string;
      if (typeof args.sheet === 'number') {
        if (args.sheet >= wb.SheetNames.length) {
          return { content: `[XLSX_ERROR] Sheet index ${args.sheet} out of range (workbook has ${wb.SheetNames.length} sheets).`, isError: true };
        }
        sheetName = wb.SheetNames[args.sheet];
      } else if (args.sheet) {
        if (!wb.SheetNames.includes(args.sheet)) {
          return {
            content: `[XLSX_ERROR] No sheet named "${args.sheet}". Available: ${wb.SheetNames.map((n: string) => `"${n}"`).join(', ')}`,
            isError: true,
          };
        }
        sheetName = args.sheet;
      } else {
        sheetName = wb.SheetNames[0];
      }
      const ws = wb.Sheets[sheetName];

      // sheet_to_json with header:1 gives array-of-arrays so we can apply our own
      // header/skipping logic uniformly with csv_read.
      const allRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      if (allRows.length === 0) {
        return { content: `Workbook: ${args.path}\nSheet: "${sheetName}"\n(empty)` };
      }

      const hasHeader = args.has_header !== false;
      const headers: string[] = hasHeader
        ? (allRows[0] as any[]).map((h, i) => String(h ?? `col${i}`))
        : (allRows[0] as any[]).map((_, i) => `col${i}`);
      const dataRows = hasHeader ? allRows.slice(1) : allRows;

      const startRow = args.start_row ?? 0;
      const maxRows = args.max_rows ?? 100;
      const slice = dataRows.slice(startRow, startRow + maxRows);

      const records = slice.map(r => {
        const obj: Record<string, any> = {};
        for (let j = 0; j < headers.length; j++) {
          const v = r[j];
          // Convert dates to ISO strings for JSON-friendliness
          obj[headers[j]!] = v instanceof Date ? v.toISOString() : (v ?? '');
        }
        return obj;
      });

      const lines: string[] = [];
      lines.push(`Workbook: ${args.path}`);
      lines.push(`Sheet: "${sheetName}"  (${wb.SheetNames.length} total)`);
      lines.push(`Total rows: ${dataRows.length}${dataRows.length > maxRows ? ` (showing rows ${startRow + 1}-${startRow + slice.length})` : ''}`);
      lines.push(`Columns (${headers.length}): ${headers.join(', ')}`);
      lines.push('');
      lines.push(JSON.stringify(records, null, 2));
      return {
        content: lines.join('\n'),
        metadata: { sheetName, totalRows: dataRows.length, returnedRows: slice.length, columns: headers },
      };
    } catch (e: any) {
      return { content: `[XLSX_ERROR] ${e?.message ?? String(e)}`, isError: true };
    }
  }
}
