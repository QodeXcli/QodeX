/**
 * `computer_use_locate` — find a UI element on screen by description and return
 * click coordinates, so a TEXT-ONLY main model can drive the desktop.
 *
 * Flow: screenshot (remembered as the coordinate reference) → vision model
 * (`vision_analyze` backends: your own vision-capable model, Ollama/LM Studio
 * VL models, Claude, GPT-4o…) with a strict prompt asking for ONE JSON object
 * `{found, x, y, w, h, confidence}` in screenshot pixels → robust parsing →
 * the element's center + "now call computer_use_click {x, y}".
 *
 * Vision models are sloppy JSON writers, so the parser accepts: code fences,
 * prose around the object, single quotes, Python booleans, trailing commas,
 * unquoted keys, `bbox: [x1,y1,x2,y2]`, Gemini-style `box_2d: [ymin,xmin,ymax,
 * xmax]` normalized to 0-1000, Qwen2.5-VL `bbox_2d` / `point_2d` (absolute
 * pixels, usually inside a JSON array), Qwen2-VL `<|box_start|>(x1,y1),(x2,y2)`
 * tokens (0-1000), `center: [x,y]`, and 0-1 fractions. Answers that land
 * outside the screenshot are rejected rather than clicked.
 */

import { z } from 'zod';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { VisionAnalyzeTool } from '../vision/vision-analyze.js';
import { captureScreenshot, defaultScreenshotPath, rememberLocated } from './backends/index.js';
import { publishDesktopAction, runDesktopTool } from './use.js';

export interface LocateBox {
  found: boolean;
  /** Center of the element, screenshot pixels. */
  x?: number;
  y?: number;
  /** Bounding box (top-left + size), screenshot pixels, when known. */
  box?: { x: number; y: number; w: number; h: number };
  confidence?: number;
  reason?: string;
}

export type LocateParse = { ok: true; result: LocateBox } | { ok: false; error: string };

/** The strict prompt sent to the vision model. PURE. */
export function buildLocatePrompt(description: string, width: number, height: number): string {
  return [
    `You are a precise UI element locator. The image is a screenshot ${width} pixels wide and ${height} pixels tall.`,
    `Find: ${JSON.stringify(description)}`,
    'Reply with ONLY one JSON object — no prose, no markdown, no code fences:',
    '{"found": true, "x": <left>, "y": <top>, "w": <width>, "h": <height>, "confidence": <0.0-1.0>}',
    `- x, y = TOP-LEFT corner of the element's bounding box; w, h = its size. All values are integer pixels of THIS image (origin top-left; 0 <= x < ${width}, 0 <= y < ${height}).`,
    '- If several elements match, choose the one the description most likely means (visible, enabled, most prominent).',
    '- If it is not visible on screen, reply {"found": false, "reason": "<short reason>"}.',
  ].join('\n');
}

// ── tolerant JSON extraction ─────────────────────────────────────────────────

/** Balanced {...} substrings (string-aware), outermost first. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { out.push(text.slice(start, i + 1)); break; }
      }
    }
  }
  return out;
}

/** Make near-JSON parseable: comments, single quotes, Python literals, unquoted keys, trailing commas. */
function repairJson(s: string): string {
  return s
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner: string) => JSON.stringify(inner.replace(/\\'/g, "'")))
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
}

function tryParse(s: string): Record<string, unknown> | null {
  for (const candidate of [s, repairJson(s)]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* next */ }
  }
  return null;
}

const COORD_KEYS = ['found', 'x', 'y', 'bbox', 'box', 'box_2d', 'bbox_2d', 'point_2d', 'point', 'center', 'cx', 'cy', 'x1', 'left'];

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function numArray(v: unknown, len: number): number[] | undefined {
  if (!Array.isArray(v) || v.length < len) return undefined;
  const arr = v.slice(0, len).map(num);
  return arr.every((n): n is number => n !== undefined) ? arr : undefined;
}

function truthy(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(true|yes|y|1)$/i.test(v.trim())) return true;
    if (/^(false|no|n|0|none|null)$/i.test(v.trim())) return false;
  }
  if (typeof v === 'number') return v !== 0;
  return undefined;
}

/**
 * Parse a vision model's answer into an element location in screenshot
 * pixels (width × height). PURE.
 */
export function parseLocateResponse(raw: string, width: number, height: number): LocateParse {
  const text = String(raw ?? '').replace(/^\s*\[via [^\]]*\]\s*/i, '').trim();
  if (!text) return { ok: false, error: 'the vision model returned an empty answer' };

  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi)) candidates.push(...balancedObjects(m[1]!));
  candidates.push(...balancedObjects(text));

  let obj: Record<string, unknown> | null = null;
  for (const c of candidates) {
    const parsed = tryParse(c);
    if (parsed && COORD_KEYS.some(k => k in parsed)) { obj = parsed; break; }
  }

  if (!obj) {
    // Qwen2-VL grounding tokens: <|box_start|>(x1,y1),(x2,y2)<|box_end|>, normalized to 0..1000.
    const qb = text.match(/<\|?box(?:_start\|)?>\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)\s*,\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/i);
    if (qb) obj = { box_2d: [Number(qb[2]), Number(qb[1]), Number(qb[4]), Number(qb[3])] };
  }
  if (!obj) {
    // Last resort: "x: 120, y: 340" style prose, or an explicit "not found".
    const mx = text.match(/\bx\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
    const my = text.match(/\by\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
    if (mx && my) obj = { found: true, x: Number(mx[1]), y: Number(my[1]) };
    else if (/\b(not\s+(found|visible|present|shown)|cannot\s+(find|see|locate)|can't\s+(find|see|locate)|no\s+such\s+element)\b/i.test(text)) {
      return { ok: true, result: { found: false, reason: text.slice(0, 200) } };
    } else {
      return { ok: false, error: `no JSON object with coordinates in the vision answer: ${text.slice(0, 200)}` };
    }
  }

  const reason = typeof obj.reason === 'string' ? obj.reason : undefined;
  let confidence = num(obj.confidence ?? obj.score ?? obj.conf);
  if (confidence !== undefined && confidence > 1 && confidence <= 100) confidence = confidence / 100;
  if (confidence !== undefined) confidence = Math.max(0, Math.min(1, confidence));

  let bx: number | undefined;
  let by: number | undefined;
  let bw: number | undefined;
  let bh: number | undefined;
  let cx: number | undefined;
  let cy: number | undefined;

  const box2d = numArray(obj.box_2d, 4);
  // Qwen2.5-VL grounding: {"bbox_2d": [x1, y1, x2, y2]} / {"point_2d": [x, y]} in absolute image pixels.
  const bbox = numArray(obj.bbox ?? obj.box ?? obj.bounding_box ?? obj.bbox_2d, 4);
  const center = numArray(obj.center ?? obj.point_2d ?? obj.point, 2);
  if (box2d) {
    // Gemini: [ymin, xmin, ymax, xmax] normalized to 0..1000.
    const [y1, x1, y2, x2] = box2d as [number, number, number, number];
    bx = (x1 / 1000) * width; by = (y1 / 1000) * height;
    bw = ((x2 - x1) / 1000) * width; bh = ((y2 - y1) / 1000) * height;
  } else if (bbox) {
    const [a, b, c, d] = bbox as [number, number, number, number];
    if (c > a && d > b) { bx = a; by = b; bw = c - a; bh = d - b; } // [x1,y1,x2,y2]
    else { bx = a; by = b; bw = c; bh = d; } // [x,y,w,h]
  } else if (num(obj.x1) !== undefined && num(obj.x2) !== undefined) {
    bx = num(obj.x1); by = num(obj.y1); bw = num(obj.x2)! - num(obj.x1)!; bh = (num(obj.y2) ?? 0) - (num(obj.y1) ?? 0);
  } else if (num(obj.left) !== undefined && num(obj.top) !== undefined) {
    bx = num(obj.left); by = num(obj.top);
    bw = num(obj.width) ?? (num(obj.right) !== undefined ? num(obj.right)! - bx! : undefined);
    bh = num(obj.height) ?? (num(obj.bottom) !== undefined ? num(obj.bottom)! - by! : undefined);
  } else if (center) {
    [cx, cy] = center as [number, number];
  } else if (num(obj.cx) !== undefined && num(obj.cy) !== undefined) {
    cx = num(obj.cx); cy = num(obj.cy);
  } else {
    bx = num(obj.x); by = num(obj.y); bw = num(obj.w ?? obj.width); bh = num(obj.h ?? obj.height);
  }

  const hasCoords = (bx !== undefined && by !== undefined) || (cx !== undefined && cy !== undefined);
  const found = truthy(obj.found) ?? hasCoords;
  if (!found) return { ok: true, result: { found: false, reason: reason ?? 'the element is not visible' } };
  if (!hasCoords) return { ok: false, error: 'the vision answer says found but gives no coordinates' };

  // 0..1 fractions → pixels.
  const vals = [bx, by, bw, bh, cx, cy].filter((v): v is number => v !== undefined);
  if (width > 50 && height > 50 && vals.length && vals.every(v => v >= 0 && v <= 1) && vals.some(v => v > 0 && v < 1)) {
    if (bx !== undefined) bx *= width;
    if (by !== undefined) by *= height;
    if (bw !== undefined) bw *= width;
    if (bh !== undefined) bh *= height;
    if (cx !== undefined) cx *= width;
    if (cy !== undefined) cy *= height;
  }

  let box: LocateBox['box'];
  if (bx !== undefined && by !== undefined) {
    if (bw !== undefined && bh !== undefined && bw > 0 && bh > 0) {
      box = { x: Math.round(bx), y: Math.round(by), w: Math.round(bw), h: Math.round(bh) };
      cx = bx + bw / 2;
      cy = by + bh / 2;
    } else {
      cx = bx; cy = by;
    }
  }

  // Off-image answers are hallucinations (or a coordinate system mix-up): don't click them.
  const tolX = width * 0.02;
  const tolY = height * 0.02;
  if (cx! < -tolX || cy! < -tolY || cx! > width + tolX || cy! > height + tolY) {
    return { ok: false, error: `the vision model answered (${Math.round(cx!)}, ${Math.round(cy!)}), outside the ${width}×${height} screenshot` };
  }
  const x = Math.min(width - 1, Math.max(0, Math.round(cx!)));
  const y = Math.min(height - 1, Math.max(0, Math.round(cy!)));
  return { ok: true, result: { found: true, x, y, box, confidence, reason } };
}

// ── analyzer injection ───────────────────────────────────────────────────────

/** Sends the screenshot + prompt to a vision model; returns its raw text. */
export type LocateAnalyzer = (imagePath: string, prompt: string, ctx: ToolContext) => Promise<{ text: string; isError?: boolean }>;

const defaultAnalyzer: LocateAnalyzer = async (imagePath, prompt, ctx) => {
  const r = await new VisionAnalyzeTool().execute({ image_path: imagePath, prompt, detail: 'high' }, ctx);
  return { text: r.content, isError: r.isError };
};

let analyzer: LocateAnalyzer = defaultAnalyzer;

/** Tests: replace the vision call (null restores vision_analyze). */
export function setLocateAnalyzer(fn: LocateAnalyzer | null): void {
  analyzer = fn ?? defaultAnalyzer;
}

/** `p`, or an `[ABORTED]` rejection as soon as `signal` fires (the abort listener is always removed). */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error('[ABORTED] computer_use_locate was cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('[ABORTED] computer_use_locate was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// ── tool ─────────────────────────────────────────────────────────────────────

const LocateArgs = z.object({
  description: z.string().min(1).describe('What to find, as specifically as possible: visible text, type and place — e.g. "the blue Save button in the dialog", "search field at the top of the Settings window", "دکمه ارسال".'),
  window: z.string().describe('Look only inside this window (app name or title substring). Omit for the whole screen.').optional(),
});

export class ComputerUseLocateTool extends Tool<z.infer<typeof LocateArgs>> {
  name = 'computer_use_locate';
  description =
    'Find a UI element on the screen by description and get its click coordinates. Takes a fresh screenshot, asks a vision model ' +
    'for the element\'s bounding box, and returns its center in that screenshot\'s pixels — pass them straight to computer_use_click. ' +
    'Needs a vision backend (same as vision_analyze).';
  // Observes the screen like a screenshot, so it must not run ahead of earlier clicks (see use.ts header).
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true; // derived from on-screen content
  argsSchema = LocateArgs;

  async execute(args: z.infer<typeof LocateArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runDesktopTool(this.name, ctx, async ({ backend, cfg }) => {
      const { shot } = await captureScreenshot(backend, { dest: defaultScreenshotPath('locate'), window: args.window, maxWidth: cfg.screenshotMaxWidth });
      ctx.emit({ type: 'progress', message: `Locating "${args.description}" on screen…` });
      // vision_analyze doesn't take a signal and a local VL model can take minutes:
      // stop waiting as soon as the call is cancelled.
      const answer = await untilAborted(analyzer(shot.path, buildLocatePrompt(args.description, shot.width, shot.height), ctx), ctx.signal);
      if (answer.isError) {
        const t = answer.text.trim();
        return {
          content: /^\[[A-Z_]+\]/.test(t) && /VISION_NOT_CONFIGURED/.test(t)
            ? `${t}\n\n(computer_use_locate needs a vision model. Screenshot kept at ${shot.path}.)`
            : `[LOCATE_FAILED] Vision analysis failed: ${t.slice(0, 600)}\nScreenshot: ${shot.path}`,
          isError: true,
        };
      }
      const parsed = parseLocateResponse(answer.text, shot.width, shot.height);
      if (!parsed.ok) {
        return {
          content: `[LOCATE_FAILED] Couldn't read coordinates from the vision model: ${parsed.error}.\nScreenshot: ${shot.path} (${shot.width}×${shot.height}). Try a more specific description, or vision_analyze the screenshot yourself.`,
          isError: true,
        };
      }
      const res = parsed.result;
      if (!res.found) {
        return {
          content: `[LOCATE_NOT_FOUND] "${args.description}" is not visible: ${res.reason ?? 'not found'}.\nScreenshot: ${shot.path}. Scroll, open/focus the right window, or describe it differently.`,
          isError: true,
          metadata: { found: false, path: shot.path },
        };
      }
      rememberLocated({ description: args.description, x: res.x!, y: res.y!, box: res.box });
      publishDesktopAction(this.name, `located "${args.description.slice(0, 80)}" at ${res.x},${res.y}`);
      const conf = res.confidence !== undefined ? `, confidence ${res.confidence.toFixed(2)}` : '';
      const lowConf = res.confidence !== undefined && res.confidence < 0.4
        ? '\n⚠ Low confidence — verify with a screenshot after clicking, or refine the description.'
        : '';
      return {
        content:
          `✓ Found "${args.description}" at (${res.x}, ${res.y})${res.box ? ` — box ${res.box.x},${res.box.y} ${res.box.w}×${res.box.h}` : ''}${conf}.\n` +
          `Coordinates are pixels of screenshot ${shot.path} (${shot.width}×${shot.height}), now the reference for clicks.${lowConf}\n` +
          `Next: computer_use_click {"x": ${res.x}, "y": ${res.y}}`,
        metadata: { found: true, x: res.x, y: res.y, box: res.box, confidence: res.confidence, path: shot.path },
      };
    });
  }
}
