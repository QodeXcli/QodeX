/**
 * computer_use_locate: robust parsing of vision-model answers (fenced,
 * prose-wrapped, sloppy JSON, alternative box formats, malformed) and the
 * tool flow with a fake backend + fake vision analyzer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolContext } from '../src/tools/base.js';
import {
  parseLocateResponse,
  buildLocatePrompt,
  setLocateAnalyzer,
  ComputerUseLocateTool,
} from '../src/tools/computer/locate.js';
import {
  setDesktopBackendForTests,
  setDesktopScreenshotsDir,
  resetDesktopState,
  getLastCapture,
  type DesktopBackend,
  type ScreenshotOptions,
  type ScreenshotResult,
} from '../src/tools/computer/backends/index.js';
import { ComputerUseClickTool } from '../src/tools/computer/use.js';

const W = 1600;
const H = 1000;

function ok(raw: string) {
  const r = parseLocateResponse(raw, W, H);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.result;
}

describe('parseLocateResponse', () => {
  it('plain JSON box → center', () => {
    expect(ok('{"found": true, "x": 100, "y": 200, "w": 50, "h": 20, "confidence": 0.9}')).toEqual({
      found: true, x: 125, y: 210, box: { x: 100, y: 200, w: 50, h: 20 }, confidence: 0.9, reason: undefined,
    });
  });

  it('strips the vision_analyze header and code fences', () => {
    const r = ok('[via ollama, 210.4KB]\n\n```json\n{"found": true, "x": 10, "y": 10, "w": 10, "h": 10, "confidence": 0.5}\n```');
    expect([r.x, r.y]).toEqual([15, 15]);
  });

  it('finds the object inside prose', () => {
    const r = ok('Sure! The Save button is at the bottom right. Here is the result: {"found": true, "x": 1400, "y": 900, "w": 100, "h": 40, "confidence": 0.82} Hope that helps.');
    expect([r.x, r.y, r.confidence]).toEqual([1450, 920, 0.82]);
  });

  it('repairs single quotes, Python booleans, unquoted keys and trailing commas', () => {
    const r = ok("{'found': True, x: 300, 'y': 400, 'w': 20, 'h': 20, 'confidence': 87,}");
    expect([r.x, r.y]).toEqual([310, 410]);
    expect(r.confidence).toBeCloseTo(0.87);
  });

  it('point without size is used as-is; string numbers are accepted', () => {
    expect(ok('{"found": "yes", "x": "640", "y": "360"}')).toMatchObject({ found: true, x: 640, y: 360 });
  });

  it('bbox corners, center arrays, and Gemini box_2d (normalized 0-1000, y first)', () => {
    expect(ok('{"bbox": [100, 100, 200, 140]}')).toMatchObject({ x: 150, y: 120 });
    expect(ok('{"found": true, "center": [700, 500]}')).toMatchObject({ x: 700, y: 500 });
    expect(ok('{"box_2d": [500, 250, 600, 750]}')).toMatchObject({ x: 800, y: 550 });
  });

  it('0..1 fractions are scaled to pixels', () => {
    expect(ok('{"found": true, "x": 0.5, "y": 0.25}')).toMatchObject({ x: 800, y: 250 });
  });

  it('not found (JSON or prose)', () => {
    expect(ok('{"found": false, "reason": "no such dialog"}')).toEqual({ found: false, reason: 'no such dialog' });
    expect(ok('I cannot find any Save button in this screenshot.').found).toBe(false);
  });

  it('prose with x:/y: values as last resort', () => {
    expect(ok('The icon center is roughly x: 512, y: 384.')).toMatchObject({ found: true, x: 512, y: 384 });
  });

  it('rejects off-screen and coordinate-less answers', () => {
    const off = parseLocateResponse('{"found": true, "x": 5000, "y": 10}', W, H);
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.error).toMatch(/outside the 1600×1000 screenshot/);
    const none = parseLocateResponse('{"found": true, "confidence": 0.9}', W, H);
    expect(none.ok).toBe(false);
  });

  it('malformed / empty answers are errors, not clicks', () => {
    expect(parseLocateResponse('', W, H).ok).toBe(false);
    expect(parseLocateResponse('{"found": true, "x": }', W, H).ok).toBe(false);
    expect(parseLocateResponse('The button is blue and rounded.', W, H).ok).toBe(false);
  });

  it('clamps answers just outside the edge', () => {
    expect(ok('{"found": true, "x": 1610, "y": -5}')).toMatchObject({ x: 1599, y: 0 });
  });

  it('prompt states the image size and the strict JSON shape', () => {
    const p = buildLocatePrompt('the OK button', 1280, 800);
    expect(p).toContain('1280 pixels wide and 800 pixels tall');
    expect(p).toContain('"found": true');
    expect(p).toContain('"the OK button"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

class FakeBackend implements DesktopBackend {
  readonly name = 'x11' as const;
  clicks: Array<[number, number]> = [];
  constructor(private readonly shot: { width: number; height: number; scale: number }) {}
  async available() { return { ok: true, missing: [], hint: '', notes: [] }; }
  async screenshot(o: ScreenshotOptions): Promise<ScreenshotResult> {
    await fs.mkdir(path.dirname(o.path), { recursive: true });
    await fs.writeFile(o.path, 'fake');
    return { path: o.path, width: this.shot.width, height: this.shot.height, scale: this.shot.scale, origin: { x: 0, y: 0 }, notes: [] };
  }
  async screenSize() { return { width: 1280, height: 800 }; }
  async cursor() { return { x: 0, y: 0 }; }
  async click(x: number, y: number) { this.clicks.push([x, y]); }
  async move() {}
  async drag() {}
  async scroll() {}
  async type() { return { method: 'type' as const }; }
  async key() {}
  async activeWindow() { return null; }
  async listWindows() { return []; }
  async focusWindow(): Promise<never> { throw new Error('nope'); }
  async openApp() { return 'opened'; }
  async clipboardGet() { return ''; }
  async clipboardSet() {}
}

function makeCtx(cwd: string): ToolContext {
  return {
    cwd, sessionId: 'test', transaction: {} as any,
    permissions: { evaluate: () => 'allow' } as any,
    askUser: async () => 'yes', emit: () => {}, signal: new AbortController().signal,
  } as ToolContext;
}

describe('computer_use_locate tool', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-locate-'));
    setDesktopScreenshotsDir(dir);
    resetDesktopState();
  });
  afterEach(async () => {
    setLocateAnalyzer(null);
    setDesktopBackendForTests(null);
    setDesktopScreenshotsDir(null);
    resetDesktopState();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns center coordinates that computer_use_click maps back to the screen', async () => {
    // A Retina-like 2× screenshot downscaled to 1600 px: scale 1.25 (1600 / 1280).
    const backend = new FakeBackend({ width: 1600, height: 1000, scale: 1.25 });
    setDesktopBackendForTests(backend);
    let prompt = '';
    setLocateAnalyzer(async (img, p) => {
      prompt = p;
      expect(img.startsWith(dir)).toBe(true);
      return { text: '[via local, 120.0KB]\n\n{"found": true, "x": 980, "y": 480, "w": 40, "h": 40, "confidence": 0.93}' };
    });
    const res = await new ComputerUseLocateTool().execute({ description: 'دکمه ارسال' }, makeCtx(dir));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('at (1000, 500)');
    expect(res.content).toContain('computer_use_click {"x": 1000, "y": 500}');
    expect(prompt).toContain('1600 pixels wide and 1000 pixels tall');
    expect(getLastCapture()!.scale).toBe(1.25);

    const click = await new ComputerUseClickTool().execute({ x: 1000, y: 500 }, makeCtx(dir));
    expect(click.isError).toBeFalsy();
    expect(backend.clicks).toEqual([[800, 400]]);
  });

  it('not found → [LOCATE_NOT_FOUND]; unparseable → [LOCATE_FAILED]; vision missing → passes the setup error', async () => {
    setDesktopBackendForTests(new FakeBackend({ width: 800, height: 600, scale: 1 }));
    setLocateAnalyzer(async () => ({ text: '{"found": false, "reason": "the dialog is closed"}' }));
    let res = await new ComputerUseLocateTool().execute({ description: 'OK button' }, makeCtx(dir));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/^\[LOCATE_NOT_FOUND\] "OK button" is not visible: the dialog is closed/);

    setLocateAnalyzer(async () => ({ text: 'It looks like a settings window.' }));
    res = await new ComputerUseLocateTool().execute({ description: 'OK button' }, makeCtx(dir));
    expect(res.content).toMatch(/^\[LOCATE_FAILED\]/);

    setLocateAnalyzer(async () => ({ text: '[VISION_NOT_CONFIGURED] No vision backend available.', isError: true }));
    res = await new ComputerUseLocateTool().execute({ description: 'OK button' }, makeCtx(dir));
    expect(res.content).toMatch(/^\[VISION_NOT_CONFIGURED\][\s\S]*needs a vision model/);
  });

  it('flags low confidence', async () => {
    setDesktopBackendForTests(new FakeBackend({ width: 800, height: 600, scale: 1 }));
    setLocateAnalyzer(async () => ({ text: '{"found": true, "x": 10, "y": 10, "w": 10, "h": 10, "confidence": 0.2}' }));
    const res = await new ComputerUseLocateTool().execute({ description: 'tiny icon' }, makeCtx(dir));
    expect(res.content).toMatch(/Low confidence/);
  });
});
