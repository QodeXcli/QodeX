/**
 * `pdf_read` tool — extract text from PDF files.
 *
 * Use cases (real ones from Hamed's businesses):
 *   - Seven Gum: read nutrition labels, packaging spec sheets, lab certificates
 *   - ChinPost: parse cargo manifests, customs forms, B/L docs, freight invoices
 *   - sg-commerce-pro: extract data from Amazon settlement statements (PDF reports)
 *
 * Implementation:
 *   - Uses Node's built-in zlib to inflate PDF content streams + a minimal
 *     tokenizer for text-extraction operators (Tj, TJ, ', ", BT/ET). This is
 *     a NO-DEPENDENCY pure-Node implementation — works without npm install.
 *   - For PDFs that store text as actual text operators (most modern PDFs from
 *     Word/InDesign/print services), extraction is clean.
 *   - For scanned PDFs (images of text), this tool returns "[SCANNED_PDF]"
 *     with the page count, so the agent knows to use `pdf_to_images` + vision_analyze
 *     instead.
 *
 * Limits:
 *   - Encrypted PDFs not supported (returns clear error)
 *   - Tables in complex layouts may have order issues (PDF text positioning is
 *     visual, not logical — we extract in document order, not visual rows)
 *   - Returns plain text; structure (headings, tables) is not preserved
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { logger } from '../../utils/logger.js';

const inflateRaw = promisify(zlib.inflateRaw);
const inflate = promisify(zlib.inflate);

const PdfReadArgs = z.object({
  path: z.string().min(1).describe('Path to a .pdf file on disk.'),
  pages: z.string().optional().describe('Page range to extract. Examples: "1-5", "3", "1,3,5-7". Default: all.'),
  max_chars: z.number().int().min(500).max(500_000).optional().describe('Truncate output. Default 50000.'),
});

interface PdfObject {
  num: number;
  gen: number;
  raw: Buffer;
  dict: string;       // string slice between << >>
  streamStart?: number;
  streamEnd?: number;
}

/**
 * Parse a PDF into its top-level objects. We do this with regex-style byte
 * scanning rather than a full parser because we only need object boundaries
 * and stream offsets — not type structure.
 */
function parseObjects(data: Buffer): PdfObject[] {
  const objects: PdfObject[] = [];
  const text = data.toString('latin1'); // PDF tokens are latin1-safe; binary stays in Buffer
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text))) {
    const num = parseInt(m[1]!, 10);
    const gen = parseInt(m[2]!, 10);
    const startIdx = m.index;
    const endIdx = text.indexOf('endobj', startIdx);
    if (endIdx === -1) continue;
    const body = text.slice(startIdx + m[0].length, endIdx);
    // dict between << ... >> (greedy, may be nested — we don't care, only need text ops)
    const dictMatch = body.match(/<<([\s\S]*?)>>/);
    const dict = dictMatch ? dictMatch[1] ?? '' : '';
    // stream marker
    const streamMarker = body.indexOf('stream');
    let streamStart: number | undefined;
    let streamEnd: number | undefined;
    if (streamMarker !== -1) {
      // The actual stream starts after 'stream' + EOL (CRLF or LF)
      let absStart = startIdx + m[0].length + streamMarker + 'stream'.length;
      if (data[absStart] === 0x0D && data[absStart + 1] === 0x0A) absStart += 2;
      else if (data[absStart] === 0x0A) absStart += 1;
      const endStreamMarker = text.indexOf('endstream', streamMarker);
      let absEnd = startIdx + m[0].length + endStreamMarker;
      // Trim trailing EOL
      if (data[absEnd - 1] === 0x0A) absEnd -= 1;
      if (data[absEnd - 1] === 0x0D) absEnd -= 1;
      streamStart = absStart;
      streamEnd = absEnd;
    }
    objects.push({
      num,
      gen,
      raw: data.subarray(startIdx, endIdx + 6),
      dict,
      streamStart,
      streamEnd,
    });
  }
  return objects;
}

/** Decode a stream based on its /Filter declarations. */
async function decodeStream(data: Buffer, dict: string): Promise<Buffer | null> {
  // Detect filter — most common is FlateDecode (zlib). LZW/RunLength rare in modern PDFs.
  const filterMatch = dict.match(/\/Filter\s*(?:\[\s*)?\/(FlateDecode|LZWDecode|ASCII85Decode|RunLengthDecode|ASCIIHexDecode|DCTDecode|CCITTFaxDecode)/);
  if (!filterMatch) {
    // No filter — return as-is
    return data;
  }
  const filter = filterMatch[1];
  if (filter === 'FlateDecode') {
    try {
      return await inflate(data);
    } catch {
      try { return await inflateRaw(data); } catch { return null; }
    }
  }
  // DCT (JPEG) / CCITT (fax) / etc — these are image streams, we skip them
  if (filter === 'DCTDecode' || filter === 'CCITTFaxDecode') return null;
  // Other filters not handled — skip
  return null;
}

/**
 * Extract text from a PDF content stream. The stream contains a sequence of
 * operators in PostScript-ish syntax. We care about:
 *   - (literal string) Tj    → show literal
 *   - <hex string> Tj         → show hex-encoded literal
 *   - [array] TJ             → show array of strings with kerning offsets
 *   - (literal) '            → newline + show literal
 *   - (literal) "             → newline + show literal (with spacing)
 *   - T*                      → newline
 *   - BT / ET                 → text block boundaries (we add line breaks at ET)
 *
 * We do NOT decode font CMaps, so non-ASCII glyphs in custom-encoded fonts may
 * come out as wrong characters. For mainstream PDFs (Type1, TrueType with WinAnsi
 * or MacRoman encoding) this works fine.
 */
function extractTextFromStream(stream: string): string {
  const out: string[] = [];

  // Process line-by-line-ish: scan for text operators
  // (literal) Tj | (literal) ' | (literal) "
  const singleStringRe = /\(((?:\\\)|\\\(|\\\\|[^()\\]|\\[0-9]{1,3}|\\[nrtbf])*)\)\s*(Tj|'|")/g;
  // <hex> Tj
  const hexStringRe = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
  // [arrays] TJ
  const arrayRe = /\[([^\]]*)\]\s*TJ/g;
  // T* and ET = line/block end
  const newlineRe = /\bT\*\b/g;
  const blockEndRe = /\bET\b/g;

  // We want to walk the stream in order, mixing all operators. Easiest:
  // tokenize by scanning forward and detecting which kind of op is next.
  // For simplicity here we do passes and merge — this loses some ordering
  // precision but works for most documents.

  // Pass 1: literals
  let m: RegExpExecArray | null;
  const tokens: Array<{ pos: number; text: string }> = [];
  singleStringRe.lastIndex = 0;
  while ((m = singleStringRe.exec(stream))) {
    tokens.push({ pos: m.index, text: decodePdfLiteral(m[1]!) + (m[2] === "'" || m[2] === '"' ? '\n' : '') });
  }
  hexStringRe.lastIndex = 0;
  while ((m = hexStringRe.exec(stream))) {
    tokens.push({ pos: m.index, text: decodeHex(m[1]!) });
  }
  arrayRe.lastIndex = 0;
  while ((m = arrayRe.exec(stream))) {
    const arrContent = m[1]!;
    // Pull out (literals) inside the array; ignore numeric kerning offsets
    const inner: string[] = [];
    const innerRe = /\(((?:\\\)|\\\(|\\\\|[^()\\]|\\[0-9]{1,3}|\\[nrtbf])*)\)|<([0-9A-Fa-f\s]+)>/g;
    let n: RegExpExecArray | null;
    while ((n = innerRe.exec(arrContent))) {
      if (n[1] !== undefined) inner.push(decodePdfLiteral(n[1]));
      else if (n[2]) inner.push(decodeHex(n[2]));
    }
    tokens.push({ pos: m.index, text: inner.join('') });
  }
  newlineRe.lastIndex = 0;
  while ((m = newlineRe.exec(stream))) {
    tokens.push({ pos: m.index, text: '\n' });
  }
  blockEndRe.lastIndex = 0;
  while ((m = blockEndRe.exec(stream))) {
    tokens.push({ pos: m.index, text: '\n' });
  }

  tokens.sort((a, b) => a.pos - b.pos);
  for (const t of tokens) out.push(t.text);
  return out.join('');
}

function decodePdfLiteral(s: string): string {
  // PDF literal string escapes
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_full, esc) => {
    if (esc === 'n') return '\n';
    if (esc === 'r') return '\r';
    if (esc === 't') return '\t';
    if (esc === 'b') return '\b';
    if (esc === 'f') return '\f';
    if (esc === '(' || esc === ')' || esc === '\\') return esc;
    // octal
    return String.fromCharCode(parseInt(esc, 8));
  });
}

function decodeHex(s: string): string {
  const clean = s.replace(/\s+/g, '');
  // Pad odd length per PDF spec
  const padded = clean.length % 2 === 0 ? clean : clean + '0';
  let result = '';
  for (let i = 0; i < padded.length; i += 2) {
    const code = parseInt(padded.slice(i, i + 2), 16);
    if (!isNaN(code)) result += String.fromCharCode(code);
  }
  return result;
}

function parsePageRange(spec: string, total: number): Set<number> {
  const wanted = new Set<number>();
  for (const part of spec.split(/[,\s]+/).filter(Boolean)) {
    const dash = part.indexOf('-');
    if (dash !== -1) {
      const a = parseInt(part.slice(0, dash), 10);
      const b = parseInt(part.slice(dash + 1), 10);
      if (!isNaN(a) && !isNaN(b)) {
        for (let i = a; i <= b && i <= total; i++) wanted.add(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n >= 1 && n <= total) wanted.add(n);
    }
  }
  return wanted;
}

export class PdfReadTool extends Tool<z.infer<typeof PdfReadArgs>> {
  name = 'pdf_read';
  description = 'Extract text from a PDF file. Works on text-based PDFs (most modern docs from Word/InDesign/print services). For scanned-image PDFs returns [SCANNED_PDF] — use browser_navigate to a PDF viewer + vision_analyze instead. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = PdfReadArgs;

  async execute(args: z.infer<typeof PdfReadArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const data = await fs.readFile(args.path);
      // Sanity check: starts with %PDF-
      if (data.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return { content: `[PDF_ERROR] Not a PDF: ${args.path}`, isError: true };
      }
      // Encryption: presence of /Encrypt in trailer dict
      const tail = data.subarray(Math.max(0, data.length - 4096)).toString('latin1');
      if (tail.includes('/Encrypt')) {
        return {
          content: `[PDF_ENCRYPTED] ${args.path} is encrypted. Decrypt it first with: qpdf --decrypt input.pdf output.pdf`,
          isError: true,
        };
      }

      const objects = parseObjects(data);
      logger.debug(`pdf_read parsed ${objects.length} objects from ${args.path}`);

      // Find pages — objects whose dict contains /Type /Page (not /Pages)
      const pageObjects = objects.filter(o => /\/Type\s*\/Page\b(?!s)/.test(o.dict));
      const totalPages = pageObjects.length;
      const wanted = args.pages ? parsePageRange(args.pages, totalPages) : null;

      // For each page, follow /Contents reference(s) and decode the stream
      const pageText: string[] = [];
      let imagesOnly = 0;
      for (let i = 0; i < pageObjects.length; i++) {
        const pageNum = i + 1;
        if (wanted && !wanted.has(pageNum)) continue;
        const pageObj = pageObjects[i]!;
        // /Contents N 0 R OR /Contents [ N 0 R M 0 R ... ]
        const contentsMatch = pageObj.dict.match(/\/Contents\s+(\d+)\s+\d+\s+R|\/Contents\s*\[([^\]]+)\]/);
        if (!contentsMatch) { pageText.push(`\n[Page ${pageNum}: no contents]\n`); continue; }
        const refs: number[] = [];
        if (contentsMatch[1]) refs.push(parseInt(contentsMatch[1], 10));
        else if (contentsMatch[2]) {
          const refRe = /(\d+)\s+\d+\s+R/g;
          let r: RegExpExecArray | null;
          while ((r = refRe.exec(contentsMatch[2]))) refs.push(parseInt(r[1]!, 10));
        }
        const pageTextParts: string[] = [];
        for (const ref of refs) {
          const streamObj = objects.find(o => o.num === ref);
          if (!streamObj || streamObj.streamStart === undefined || streamObj.streamEnd === undefined) continue;
          const raw = data.subarray(streamObj.streamStart, streamObj.streamEnd);
          const decoded = await decodeStream(raw, streamObj.dict);
          if (!decoded) continue;
          const streamStr = decoded.toString('latin1');
          const text = extractTextFromStream(streamStr);
          pageTextParts.push(text);
        }
        const joined = pageTextParts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (joined.length < 20) imagesOnly++; // probably a scanned page
        pageText.push(`\n--- Page ${pageNum} ---\n${joined || '[no extractable text — likely scanned image]'}\n`);
      }

      if (imagesOnly === pageObjects.length && pageObjects.length > 0) {
        return {
          content: `[SCANNED_PDF] ${args.path} appears to be ${totalPages} page(s) of scanned images with no extractable text layer. ` +
            `To analyze: render each page to PNG and use vision_analyze. Tools like qpdf, pdftoppm, or ImageMagick can rasterize.`,
        };
      }

      const all = pageText.join('\n');
      const maxChars = args.max_chars ?? 50_000;
      const truncated = all.length > maxChars;
      const final = truncated ? all.slice(0, maxChars) + `\n\n…[truncated, ${all.length - maxChars} more chars]` : all;
      return {
        content: `PDF: ${args.path}\nTotal pages: ${totalPages}\nExtracted: ${wanted ? wanted.size : totalPages} page(s)\nLength: ${all.length} chars${imagesOnly > 0 ? `\nPages without text: ${imagesOnly} (likely scanned)` : ''}\n${final}`,
        metadata: { totalPages, extractedPages: wanted ? wanted.size : totalPages, truncated, scannedPages: imagesOnly },
      };
    } catch (e: any) {
      return { content: `[PDF_ERROR] ${e?.message ?? String(e)}`, isError: true };
    }
  }
}
