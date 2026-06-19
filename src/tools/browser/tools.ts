/**
 * `browser_*` tools — drive a headless Chromium instance via Playwright.
 *
 * All tools share a single Page (see ./session.ts). Selectors follow Playwright
 * syntax (CSS, text="...", xpath=..., role=..., id=..., etc).
 *
 * Tools defined here:
 *   - browser_navigate    — load a URL, returns title + final URL
 *   - browser_click       — click an element matching a selector
 *   - browser_fill        — type into an input
 *   - browser_screenshot  — capture PNG, save to /tmp, return path + dimensions
 *   - browser_console     — read captured console.log/warn/error messages
 *   - browser_evaluate    — run arbitrary JavaScript and return the result
 *   - browser_get_text    — extract visible text from an element (or whole page)
 *   - browser_wait_for    — wait for a selector / URL pattern / network idle
 *   - browser_close       — explicitly close the browser (otherwise closes on session end)
 *
 * Mutating? Yes — every interaction mutates the loaded page. Counted as
 * destructive in the permission system so the user sees them in `/auto` flows.
 * Read-only sub-tools: browser_console, browser_get_text, browser_screenshot.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getSession, clearBuffers, closeBrowser } from './session.js';
import { logger } from '../../utils/logger.js';

const NavigateArgs = z.object({
  url: z.string().min(1).describe('URL to navigate to. Must include scheme (http:// or https://).'),
  wait_until: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional().describe(
    "When to consider navigation done. 'domcontentloaded' (default) = DOM parsed — doesn't wait for third-party assets/trackers that often hang. " +
    "'load' = window.onload (waits for everything; routinely times out on heavy pages). " +
    "'networkidle' = quiet for 500ms (best for SPAs that defer rendering)."
  ),
  timeout_ms: z.number().int().min(1000).max(120_000).optional().describe('Max wait. Default 30000.'),
  return_html: z.boolean().optional().describe('Also include the page HTML in the response (truncated to 25k chars). Default false. On timeout, HTML is included automatically.'),
});

export class BrowserNavigateTool extends Tool<z.infer<typeof NavigateArgs>> {
  name = 'browser_navigate';
  description = 'Load a URL in the QodeX-managed headless Chromium browser. First call launches the browser (~2s). Default waitUntil is "domcontentloaded" — works on heavy pages where window.onload would time out behind slow third-party assets. On timeout the tool returns partial state (title/url/HTML) instead of erroring, so you can still inspect/screenshot/click. Resets console/network/error buffers for the new page.';
  isReadOnly = false;
  isDestructive = false; // not destructive to user filesystem; tagged !readOnly so permission system shows it
  argsSchema = NavigateArgs;

  async execute(args: z.infer<typeof NavigateArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const waitUntil = args.wait_until ?? 'domcontentloaded';
    const timeout = args.timeout_ms ?? 30_000;
    const s = await getSession();
    clearBuffers(s);

    // Try the navigation. Catch Playwright's TimeoutError and fall through to a
    // best-effort recovery — many real pages never finish according to `load`
    // (trackers, analytics, prefetch beacons), and even `domcontentloaded` can
    // hang on giant SPAs. The user almost always prefers a partial render they
    // can inspect over a hard error.
    let status: number | undefined;
    let timedOut = false;
    let phaseError: string | undefined;
    try {
      const r = await s.page.goto(args.url, { waitUntil, timeout });
      status = r?.status();
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const isTimeout =
        e?.name === 'TimeoutError' ||
        /Timeout \d+ms exceeded/i.test(msg) ||
        /navigation timeout/i.test(msg);
      if (!isTimeout) {
        return { content: `[BROWSER_ERROR] navigate failed: ${msg}`, isError: true };
      }
      timedOut = true;
      phaseError = msg.split('\n')[0];
      logger.info('browser_navigate timed out; returning partial state', { url: args.url, waitUntil, timeout });
    }

    // Each accessor can itself fail if the page is in a weird state; wrap individually
    // so one failure doesn't wipe out the others.
    let title = '';
    try { title = await s.page.title(); } catch { /* keep '' */ }
    const finalUrl = (() => { try { return s.page.url(); } catch { return args.url; } })();

    let htmlSection = '';
    if (args.return_html === true || timedOut) {
      try {
        const html = await s.page.content();
        const max = 25_000;
        const slice = html.length > max
          ? html.slice(0, max) + `\n\n…[truncated, ${html.length - max} more chars]`
          : html;
        htmlSection = `\n\n--- HTML (${html.length} chars) ---\n${slice}`;
      } catch (e: any) {
        htmlSection = `\n\n--- HTML unavailable: ${e?.message ?? String(e)} ---`;
      }
    }

    const banner = timedOut
      ? `[PARTIAL_LOAD] navigation timed out after ${timeout}ms (waitUntil=${waitUntil}); returning whatever the DOM has so far. Reason: ${phaseError ?? 'timeout'}`
      : `Loaded ${finalUrl}`;

    return {
      content:
        `${banner}\n` +
        `  HTTP ${status ?? '?'}\n` +
        `  Title: ${title || '(none)'}\n` +
        `  Final URL: ${finalUrl}\n` +
        `  Console: ${s.consoleBuffer.length} msg(s)\n` +
        `  Errors: ${s.errorBuffer.length}` +
        htmlSection,
      metadata: { url: finalUrl, status, title, timedOut, waitUntil },
    };
  }
}

const ClickArgs = z.object({
  selector: z.string().min(1).describe(
    'Playwright selector. Examples: "button.submit", "text=Sign in", "role=button[name=\\"Submit\\"]", "#email", "xpath=//button[1]".'
  ),
  timeout_ms: z.number().int().min(100).max(60_000).optional().describe('Max wait for selector. Default 5000.'),
  button: z.enum(['left', 'right', 'middle']).optional(),
  click_count: z.number().int().min(1).max(3).optional().describe('1 = single, 2 = double, 3 = triple.'),
});

export class BrowserClickTool extends Tool<z.infer<typeof ClickArgs>> {
  name = 'browser_click';
  description = 'Click an element matching a Playwright selector. Waits up to 5s for the element to become actionable (visible + enabled). Use after browser_navigate.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = ClickArgs;

  async execute(args: z.infer<typeof ClickArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const s = await getSession();
      await s.page.click(args.selector, {
        timeout: args.timeout_ms ?? 5000,
        button: args.button ?? 'left',
        clickCount: args.click_count ?? 1,
      });
      return { content: `Clicked: ${args.selector}` };
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] click failed for "${args.selector}": ${e?.message ?? String(e)}`, isError: true };
    }
  }
}

const FillArgs = z.object({
  selector: z.string().min(1).describe('Selector for the input/textarea/contenteditable.'),
  value: z.string().describe('Text to type. Replaces any existing content.'),
  timeout_ms: z.number().int().min(100).max(60_000).optional(),
});

export class BrowserFillTool extends Tool<z.infer<typeof FillArgs>> {
  name = 'browser_fill';
  description = 'Fill an input/textarea/contenteditable. Replaces existing content. For non-text widgets (date picker, range slider) use browser_evaluate.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = FillArgs;

  async execute(args: z.infer<typeof FillArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const s = await getSession();
      await s.page.fill(args.selector, args.value, { timeout: args.timeout_ms ?? 5000 });
      return { content: `Filled ${args.selector} with ${args.value.length} char(s)` };
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] fill failed for "${args.selector}": ${e?.message ?? String(e)}`, isError: true };
    }
  }
}

const ScreenshotArgs = z.object({
  full_page: z.boolean().optional().describe('Capture entire scrollable area (true) or just viewport (false, default).'),
  selector: z.string().optional().describe('If set, screenshot only the matching element.'),
  path: z.string().optional().describe('Where to save the PNG. Defaults to a tmp file under /tmp/qodex-screenshots/.'),
});

export class BrowserScreenshotTool extends Tool<z.infer<typeof ScreenshotArgs>> {
  name = 'browser_screenshot';
  description = 'Capture a PNG of the current page (or a specific element). Returns the file path; the image is NOT inlined to keep the agent context small. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ScreenshotArgs;

  async execute(args: z.infer<typeof ScreenshotArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const s = await getSession();
      const dir = path.join(os.tmpdir(), 'qodex-screenshots');
      await fs.mkdir(dir, { recursive: true });
      const dest = args.path ?? path.join(dir, `shot-${Date.now()}.png`);
      if (args.selector) {
        const el = await s.page.$(args.selector);
        if (!el) return { content: `[BROWSER_ERROR] selector not found: ${args.selector}`, isError: true };
        await el.screenshot({ path: dest });
      } else {
        await s.page.screenshot({ path: dest, fullPage: args.full_page ?? false });
      }
      const stat = await fs.stat(dest);
      const viewport = s.page.viewportSize();
      return {
        content: `Screenshot saved: ${dest}\n  Size: ${(stat.size / 1024).toFixed(1)} KB${viewport ? `\n  Viewport: ${viewport.width}x${viewport.height}` : ''}`,
      };
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] screenshot failed: ${e?.message ?? String(e)}`, isError: true };
    }
  }
}

const ConsoleArgs = z.object({
  level: z.enum(['all', 'error', 'warn', 'info', 'log', 'debug']).optional(),
  limit: z.number().int().min(1).max(500).optional().describe('Max messages to return. Default 50, newest last.'),
});

export class BrowserConsoleTool extends Tool<z.infer<typeof ConsoleArgs>> {
  name = 'browser_console';
  description = 'Read browser console messages + page errors since the last navigate. Use to debug JavaScript errors after interacting with the page. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = ConsoleArgs;

  async execute(args: z.infer<typeof ConsoleArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const s = await getSession();
    const level = args.level ?? 'all';
    const limit = args.limit ?? 50;
    const filtered = level === 'all'
      ? s.consoleBuffer
      : s.consoleBuffer.filter(m => m.type === level);
    const slice = filtered.slice(-limit);
    const consoleLines = slice.length === 0
      ? '  (no messages)'
      : slice.map(m => `  [${m.type}] ${m.text}${m.location ? `  (${m.location})` : ''}`).join('\n');
    const errors = s.errorBuffer.length === 0
      ? '  (no page errors)'
      : s.errorBuffer.map(e => `  ${e.message}`).join('\n');
    return {
      content: `Console (${slice.length}/${filtered.length} ${level} message(s)):\n${consoleLines}\n\nPage errors (${s.errorBuffer.length}):\n${errors}`,
    };
  }
}

const EvaluateArgs = z.object({
  script: z.string().min(1).describe(
    'JavaScript to run in the page context. Treated as a function body — use `return` to send a value back. ' +
    'Example: "return document.querySelectorAll(\'a\').length"'
  ),
  arg: z.any().optional().describe('Optional argument passed as the first parameter to the script.'),
});

export class BrowserEvaluateTool extends Tool<z.infer<typeof EvaluateArgs>> {
  name = 'browser_evaluate';
  description = 'Run JavaScript in the page context and return the result. Wrap the script as a function body (use `return`). Returned values must be JSON-serializable.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = EvaluateArgs;

  async execute(args: z.infer<typeof EvaluateArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const s = await getSession();
      // Wrap so the user can use `return` naturally in their script.
      const fn = new Function('arg', args.script);
      const result = await s.page.evaluate(fn.toString(), args.arg);
      const formatted = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
      return { content: `Result:\n${formatted.slice(0, 5000)}${formatted.length > 5000 ? '\n…[truncated]' : ''}` };
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] evaluate failed: ${e?.message ?? String(e)}`, isError: true };
    }
  }
}

const GetTextArgs = z.object({
  selector: z.string().optional().describe('If set, returns text of matching element. Otherwise full visible body text.'),
  max_chars: z.number().int().min(1).max(50_000).optional().describe('Truncate output. Default 5000.'),
});

export class BrowserGetTextTool extends Tool<z.infer<typeof GetTextArgs>> {
  name = 'browser_get_text';
  description = 'Extract visible text from the page (or a specific element). Skips <script>, <style>. Use to verify content after interactions. Read-only.';
  isReadOnly = true;
  isDestructive = false;
  argsSchema = GetTextArgs;

  async execute(args: z.infer<typeof GetTextArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const s = await getSession();
      const maxChars = args.max_chars ?? 5000;
      let text: string;
      if (args.selector) {
        const el = await s.page.$(args.selector);
        if (!el) return { content: `[BROWSER_ERROR] selector not found: ${args.selector}`, isError: true };
        text = await el.innerText();
      } else {
        text = await s.page.innerText('body');
      }
      const truncated = text.length > maxChars;
      return {
        content: `${text.slice(0, maxChars)}${truncated ? `\n…[truncated, ${text.length - maxChars} more chars]` : ''}`,
        metadata: { fullLength: text.length },
      };
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] get_text failed: ${e?.message ?? String(e)}`, isError: true };
    }
  }
}

const WaitForArgs = z.object({
  kind: z.enum(['selector', 'url', 'networkidle', 'function']).describe(
    'What to wait for. "selector"=DOM element, "url"=URL matches pattern, "networkidle"=no network for 500ms, "function"=custom JS returns truthy.'
  ),
  value: z.string().optional().describe('Selector / URL pattern / JS expression. Not needed for networkidle.'),
  timeout_ms: z.number().int().min(100).max(120_000).optional().describe('Default 10000.'),
});

export class BrowserWaitForTool extends Tool<z.infer<typeof WaitForArgs>> {
  name = 'browser_wait_for';
  description = 'Wait for a DOM element, URL change, network idle, or a custom JS predicate. Useful for SPAs where action effects are async.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = WaitForArgs;

  async execute(args: z.infer<typeof WaitForArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const s = await getSession();
      const timeout = args.timeout_ms ?? 10_000;
      if (args.kind === 'selector') {
        if (!args.value) return { content: '[BROWSER_ERROR] selector kind requires `value`', isError: true };
        await s.page.waitForSelector(args.value, { timeout });
        return { content: `Selector visible: ${args.value}` };
      } else if (args.kind === 'url') {
        if (!args.value) return { content: '[BROWSER_ERROR] url kind requires `value`', isError: true };
        await s.page.waitForURL(args.value, { timeout });
        return { content: `URL matched: ${s.page.url()}` };
      } else if (args.kind === 'networkidle') {
        await s.page.waitForLoadState('networkidle', { timeout });
        return { content: 'Network idle reached' };
      } else if (args.kind === 'function') {
        if (!args.value) return { content: '[BROWSER_ERROR] function kind requires `value`', isError: true };
        await s.page.waitForFunction(args.value, undefined, { timeout });
        return { content: `Predicate satisfied: ${args.value.slice(0, 80)}` };
      }
      return { content: '[BROWSER_ERROR] unknown wait kind', isError: true };
    } catch (e: any) {
      return { content: `[BROWSER_ERROR] wait_for failed: ${e?.message ?? String(e)}`, isError: true };
    }
  }
}

const CloseArgs = z.object({});

export class BrowserCloseTool extends Tool<z.infer<typeof CloseArgs>> {
  name = 'browser_close';
  description = 'Close the headless browser. Idempotent. The next browser_* call will relaunch.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = CloseArgs;

  async execute(_args: z.infer<typeof CloseArgs>, _ctx: ToolContext): Promise<ToolResult> {
    await closeBrowser();
    return { content: 'Browser closed.' };
  }
}
