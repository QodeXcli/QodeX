import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { buildPrintLayoutSvg } from './print/layout.js';
import { normalizeEan13 } from './print/ean13.js';

const PrintLayoutArgs = z.object({
  width_mm: z.number().positive().describe('Trim width in millimetres (final cut size, excluding bleed).'),
  height_mm: z.number().positive().describe('Trim height in millimetres.'),
  output_path: z.string().describe('Where to write the .svg file (absolute or relative to the working dir).'),
  title: z.string().optional().describe('Main label text (centered near the top). RTL is auto-detected for Persian/Arabic.'),
  legal_lines: z.array(z.string()).optional().describe('Small-print lines: ingredients, net weight, warnings. Stacked above the barcode.'),
  barcode: z.string().optional().describe('EAN-13 code: 12 digits (check digit computed) or 13 digits (validated). Rendered as a real scannable barcode.'),
  bleed_mm: z.number().min(0).optional().describe('Bleed margin outside the cut line. Default 3mm (print standard).'),
  safe_mm: z.number().min(0).optional().describe('Safe zone inside the cut line where text must stay. Default 3mm.'),
  background_image: z.string().optional().describe('Path/URL to a raster background (e.g. a ComfyUI-generated texture) embedded as the bottom layer. Optional.'),
  bg_color: z.string().optional().describe('Fallback background fill (CSS color) when no background image. Default light gray.'),
});

export class PrintLayoutEngineTool extends Tool<z.infer<typeof PrintLayoutArgs>> {
  name = 'print_layout_engine';
  description = 'Generate a print-ready SVG label/packaging/banner artwork at true physical size (millimetres), with separate layers (background, title, legal-text, barcode, safe-zone guide, magenta die-line/cut). Produces a real scannable EAN-13 barcode. The output opens cleanly in CorelDRAW/Illustrator for prepress. This handles exact geometry only — for artistic background textures, generate an image separately and pass it via background_image. Writes an .svg file.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = PrintLayoutArgs;

  async execute(args: z.infer<typeof PrintLayoutArgs>, ctx: ToolContext): Promise<ToolResult> {
    // Validate barcode up front so the model gets a clear error, not a silent bad label.
    let barcodeNote = '';
    if (args.barcode) {
      try {
        const { digits, checkOk } = normalizeEan13(args.barcode);
        barcodeNote = checkOk ? `EAN-13 ${digits} (valid)` : `EAN-13 ${digits} (CHECK DIGIT MISMATCH — verify the code)`;
      } catch (e) {
        return { content: `Invalid barcode: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    }

    const svg = buildPrintLayoutSvg({
      widthMm: args.width_mm,
      heightMm: args.height_mm,
      bleedMm: args.bleed_mm,
      safeMm: args.safe_mm,
      title: args.title,
      legalLines: args.legal_lines,
      barcode: args.barcode,
      backgroundImageHref: args.background_image,
      bgColor: args.bg_color,
    });

    const outPath = path.isAbsolute(args.output_path) ? args.output_path : path.resolve(ctx.cwd, args.output_path);
    try {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, svg, 'utf-8');
    } catch (e) {
      return { content: `Failed to write ${outPath}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }

    const bleed = args.bleed_mm ?? 3;
    const lines = [
      `Wrote ${outPath}`,
      `Canvas: ${args.width_mm + 2 * bleed}×${args.height_mm + 2 * bleed}mm (trim ${args.width_mm}×${args.height_mm}mm + ${bleed}mm bleed)`,
      `Layers: background, ${args.title ? 'title, ' : ''}${args.legal_lines?.length ? 'legal-text, ' : ''}${args.barcode ? 'barcode, ' : ''}safe-zone (guide), die-line (magenta = cut)`,
    ];
    if (barcodeNote) lines.push(barcodeNote);
    if (!args.background_image) lines.push('Tip: generate a background texture (e.g. via ComfyUI) and re-run with background_image to embed art behind the layout.');
    return { content: lines.join('\n'), metadata: { outPath, bytes: svg.length } };
  }
}
