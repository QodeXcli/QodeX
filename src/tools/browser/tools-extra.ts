/**
 * `browser_*` tools (extended set) for the dedicated QodeX Browser:
 *
 *   observe : browser_snapshot, browser_extract, browser_network, browser_status
 *   act     : browser_type, browser_fill_form, browser_select, browser_hover,
 *             browser_press, browser_scroll, browser_drag, browser_upload,
 *             browser_history, browser_tabs
 *   manage  : browser_downloads, browser_dialog, browser_pdf
 *
 * Same conventions as tools.ts: targets are snapshot refs (preferred) or
 * selectors; actions go through `runBrowserAction` (takeover wait, dialog race,
 * popup/navigation notes, action recording with password redaction, compact
 * snapshot after the action). Page-observing tools are deliberately NOT
 * read-only (see the header of tools.ts: the loop runs read-only calls first and
 * caches them, which would observe the page before a click in the same
 * response). Only browser_status — pure manager state that never launches the
 * browser — is read-only.
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from '../base.js';
import { getBrowserManager, type ElementInfo } from './types.js';
import { normalizeUrl, normalizeKey, formatBytes } from './session.js';
import { extractContent, type ExtractFormat } from './snapshot.js';
import { QODEX_BROWSER_DOWNLOADS_DIR } from '../../config/paths.js';
import {
  asQodex,
  browserErrorResult,
  checkOutputPath,
  composeActionResult,
  describeTarget,
  isProtectedFileUrlReal,
  isProtectedQodexPathReal,
  notRunningResult,
  redactForRecord,
  refField,
  resolveUserPath,
  runBrowserAction,
  selectorField,
  snapshotField,
  targetOf,
  throwIfAborted,
  timeoutField,
  waitForHuman,
  withAbort,
} from './tools.js';

function firstLine(e: unknown): string {
  return String((e as any)?.message ?? e).split('\n')[0];
}

// ── browser_snapshot ────────────────────────────────────────────────────────

const SnapshotArgs = z.object({
  interactive_only: z.boolean().describe('Only actionable elements (buttons, links, fields, options) + headings. Smaller; good for deciding the next click.').optional(),
  selector: z.string().describe('Snapshot only this part of the page (Playwright selector), e.g. "main" or "form#checkout".').optional(),
  max_chars: z.number().int().min(500).max(200_000).describe('Cap on snapshot size. Default browser.snapshotMaxChars (12000).').optional(),
});

export class BrowserSnapshotTool extends Tool<z.infer<typeof SnapshotArgs>> {
  name = 'browser_snapshot';
  description =
    'Accessibility snapshot of the active tab: roles, names and text, with a ref for every element you can act on ' +
    '(e.g. `- button "Add to cart" [ref=e42]`). Use the refs with browser_click / browser_type / browser_fill_form / browser_select. ' +
    'Take a NEW snapshot whenever the page changed — old refs go stale. Header shows title, URL and tabs.';
  // Not read-only on purpose (ordering vs. actions in the same response; see tools.ts).
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = SnapshotArgs;

  async execute(args: z.infer<typeof SnapshotArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      if (!mgr.isRunning()) return notRunningResult();
      const qm = asQodex(mgr);
      if (!qm) return { content: '[BROWSER_ERROR] snapshots need the QodeX browser manager.', isError: true };
      const max = args.max_chars ?? qm.currentConfig().snapshotMaxChars;
      const snap = await qm.snapshot({ interactiveOnly: args.interactive_only, selector: args.selector, maxChars: max });
      const notes = qm.drainNotices().map(n => `• ${n}`);
      return {
        content: [...notes, ...(notes.length ? [''] : []), snap.text].join('\n'),
        metadata: { url: snap.url, title: snap.title, refs: snap.refCount, truncated: snap.truncated, mode: snap.mode },
      };
    } catch (e) {
      return browserErrorResult(e, 'snapshot');
    }
  }
}

// ── browser_type ────────────────────────────────────────────────────────────

const TypeArgs = z.object({
  ref: refField(),
  selector: selectorField(),
  text: z.string().describe('Text to type. Without ref/selector it is typed into the focused element.'),
  submit: z.boolean().describe('Press Enter afterwards (submit a search box / form).').optional(),
  clear: z.boolean().describe('Clear the field first (default true). false = append to existing text.').optional(),
  slowly: z.boolean().describe('Type one key at a time (for fields with autocomplete / key handlers). Default false = fill at once.').optional(),
  timeout_ms: timeoutField(),
  snapshot: snapshotField(),
});

export class BrowserTypeTool extends Tool<z.infer<typeof TypeArgs>> {
  name = 'browser_type';
  description =
    'Type text into a field (by ref or selector; else the focused element). clear=true (default) replaces the content, ' +
    'slowly=true types key by key (autocomplete widgets), submit=true presses Enter afterwards. Never type passwords you were not given — use browser_fill_secret.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = TypeArgs;

  async execute(args: z.infer<typeof TypeArgs>, ctx: ToolContext): Promise<ToolResult> {
    const target = targetOf(args);
    const clear = args.clear !== false;
    return runBrowserAction({
      tool: 'browser_type',
      ctx,
      target,
      focusTarget: true,
      snapshot: args.snapshot,
      timeoutMs: args.timeout_ms,
      recordArgs: { ...target, text: args.text, ...(args.submit ? { submit: true } : {}), ...(clear ? {} : { clear: false }) },
      perform: async ({ page, locator, element, timeout }) => {
        if (locator) {
          if (clear && !args.slowly) {
            try {
              await locator.fill(args.text, { timeout });
            } catch (e) {
              if (!/not an <input>|is not editable|not an editable/i.test(firstLine(e))) throw e;
              await locator.click({ timeout });
              await page.keyboard.type(args.text);
            }
          } else {
            if (clear) await locator.fill('', { timeout });
            else await locator.focus({ timeout });
            if (!clear) await page.keyboard.press('End').catch(() => {});
            if (typeof locator.pressSequentially === 'function') await locator.pressSequentially(args.text, { delay: args.slowly ? 60 : 0, timeout });
            else await locator.type(args.text, { delay: args.slowly ? 60 : 0, timeout });
          }
          if (args.submit) await locator.press('Enter', { timeout });
        } else {
          await page.keyboard.type(args.text, { delay: args.slowly ? 60 : 0 });
          if (args.submit) await page.keyboard.press('Enter');
        }
        const where = locator
          ? describeTarget(element, target)
          : element?.role || element?.name ? `the focused ${describeTarget(element, null)}` : 'the focused element';
        return `✓ Typed ${args.text.length} char(s)${element?.isPassword ? ' (hidden)' : ''} into ${where}${args.submit ? ' and pressed Enter' : ''}`;
      },
    });
  }
}

// ── browser_fill_form ───────────────────────────────────────────────────────

const FillFormArgs = z.object({
  fields: z.array(z.object({
    ref: z.string().describe('Field ref from browser_snapshot (e.g. "e7").').optional(),
    selector: z.string().describe('Playwright selector when there is no ref.').optional(),
    value: z.string().describe('Text for textboxes; option label/value for selects; "true"/"false" (or "on"/"off") for checkboxes, radios and switches.'),
  })).min(1).describe('Fields to set, in order.'),
  snapshot: snapshotField(),
});

const TRUE_WORDS = new Set(['true', 'on', 'yes', '1', 'checked', 'check', 'y']);
const FALSE_WORDS = new Set(['false', 'off', 'no', '0', 'unchecked', 'uncheck', 'n', '']);

export class BrowserFillFormTool extends Tool<z.infer<typeof FillFormArgs>> {
  name = 'browser_fill_form';
  description =
    'Fill several form fields in one call: textboxes are filled, checkboxes/radios/switches set from "true"/"false", ' +
    'selects pick the option by label or value. Each field is a {ref, value} from the latest browser_snapshot. Does not submit — click the submit button afterwards.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = FillFormArgs;

  async execute(args: z.infer<typeof FillFormArgs>, ctx: ToolContext): Promise<ToolResult> {
    let failures = 0;
    const result = await runBrowserAction({
      tool: 'browser_fill_form',
      ctx,
      snapshot: args.snapshot,
      recordArgs: null, // each field is recorded as its primitive action below
      perform: async ({ mgr, timeout }) => {
        const qm = asQodex(mgr);
        const lines: string[] = [];
        for (const [i, f] of args.fields.entries()) {
          const target = targetOf(f);
          const label = target?.ref ? `ref ${target.ref}` : target?.selector ? `"${target.selector}"` : `field #${i + 1}`;
          if (!target) { failures++; lines.push(`✗ ${label}: needs a ref or selector`); continue; }
          try {
            const loc = await mgr.locator(target);
            const el: ElementInfo | null = qm ? await qm.describeLocator(loc) : null;
            const role = el?.role ?? '';
            const tag = el?.tag ?? '';
            const type = el?.inputType ?? '';
            const name = describeTarget(el, target);
            const url = mgr.activeUrl();
            if (tag === 'select') {
              const chosen: string[] = await loc.selectOption(f.value, { timeout });
              lines.push(`✓ ${name} → ${chosen.join(', ') || f.value}`);
              mgr.recordAction({ tool: 'browser_select', args: { ...target, values: [f.value] }, url, element: el ?? undefined, actor: 'agent' });
            } else if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role) || type === 'checkbox' || type === 'radio') {
              const v = f.value.trim().toLowerCase();
              if (!TRUE_WORDS.has(v) && !FALSE_WORDS.has(v)) {
                failures++;
                lines.push(`✗ ${name}: value "${f.value}" is not true/false`);
                continue;
              }
              const want = TRUE_WORDS.has(v);
              const was = await loc.isChecked({ timeout }).catch(() => null);
              if (!want && (role === 'radio' || type === 'radio')) {
                lines.push(`• ${name}: a radio button cannot be unchecked directly — choose another option instead`);
                continue;
              }
              await loc.setChecked(want, { timeout });
              lines.push(`✓ ${name} → ${want ? 'checked' : 'unchecked'}`);
              if (was !== want) mgr.recordAction({ tool: 'browser_click', args: { ...target }, url, element: el ?? undefined, actor: 'agent' });
            } else {
              await loc.fill(f.value, { timeout });
              lines.push(`✓ ${name} ← ${f.value.length} char(s)${el?.isPassword ? ' (hidden)' : ''}`);
              mgr.recordAction({ tool: 'browser_fill', args: redactForRecord({ ...target, value: f.value }, el), url, element: el ?? undefined, actor: 'agent' });
            }
          } catch (e) {
            failures++;
            const r = browserErrorResult(e, `field ${label}`);
            lines.push(`✗ ${r.content.replace(/^\[BROWSER_ERROR\] /, '')}`);
          }
        }
        lines.unshift(`${failures ? '⚠' : '✓'} Filled ${args.fields.length - failures}/${args.fields.length} field(s)`);
        return lines;
      },
    });
    return failures && !result.isError ? { ...result, isError: true } : result;
  }
}

// ── browser_select ──────────────────────────────────────────────────────────

const SelectArgs = z.object({
  ref: refField(),
  selector: selectorField(),
  values: z.array(z.string()).min(1).describe('Option label(s) or value(s) to select (several only for multi-selects).'),
  timeout_ms: timeoutField(),
  snapshot: snapshotField(),
});

export class BrowserSelectTool extends Tool<z.infer<typeof SelectArgs>> {
  name = 'browser_select';
  description = 'Choose option(s) in a <select> dropdown (by ref or selector) by visible label or value. For custom (non-<select>) dropdowns, click to open them and click the option instead.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = SelectArgs;

  async execute(args: z.infer<typeof SelectArgs>, ctx: ToolContext): Promise<ToolResult> {
    const target = targetOf(args);
    return runBrowserAction({
      tool: 'browser_select',
      ctx,
      target,
      requireTarget: true,
      snapshot: args.snapshot,
      timeoutMs: args.timeout_ms,
      recordArgs: { ...target, values: args.values },
      perform: async ({ locator, element, timeout }) => {
        const chosen: string[] = await locator.selectOption(args.values, { timeout });
        return `✓ Selected ${chosen.length ? chosen.join(', ') : args.values.join(', ')} in ${describeTarget(element, target)}`;
      },
    });
  }
}

// ── browser_hover ───────────────────────────────────────────────────────────

const HoverArgs = z.object({
  ref: refField(),
  selector: selectorField(),
  timeout_ms: timeoutField(),
  snapshot: snapshotField(),
});

export class BrowserHoverTool extends Tool<z.infer<typeof HoverArgs>> {
  name = 'browser_hover';
  description = 'Move the mouse over an element (by ref or selector) — opens hover menus and tooltips. Returns a fresh snapshot showing what appeared.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = HoverArgs;

  async execute(args: z.infer<typeof HoverArgs>, ctx: ToolContext): Promise<ToolResult> {
    const target = targetOf(args);
    return runBrowserAction({
      tool: 'browser_hover',
      ctx,
      target,
      requireTarget: true,
      snapshot: args.snapshot,
      timeoutMs: args.timeout_ms,
      recordArgs: { ...target },
      perform: async ({ locator, element, timeout }) => {
        await locator.hover({ timeout });
        return `✓ Hovering over ${describeTarget(element, target)}`;
      },
    });
  }
}

// ── browser_press ───────────────────────────────────────────────────────────

const PressArgs = z.object({
  key: z.string().min(1).describe('Key or chord: "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "Control+a", "Meta+Enter"…'),
  ref: refField(),
  selector: selectorField(),
  snapshot: snapshotField(),
});

export class BrowserPressTool extends Tool<z.infer<typeof PressArgs>> {
  name = 'browser_press';
  description = 'Press a key or key chord, on an element (ref/selector focuses it first) or on whatever is focused. E.g. Enter to submit, Escape to close a modal, ArrowDown in a list.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = PressArgs;

  async execute(args: z.infer<typeof PressArgs>, ctx: ToolContext): Promise<ToolResult> {
    const target = targetOf(args);
    const key = normalizeKey(args.key);
    return runBrowserAction({
      tool: 'browser_press',
      ctx,
      target,
      focusTarget: true,
      snapshot: args.snapshot,
      recordArgs: { ...target, key },
      perform: async ({ page, locator, element, timeout }) => {
        if (locator) await locator.press(key, { timeout });
        else await page.keyboard.press(key);
        return `✓ Pressed ${key}${locator ? ` on ${describeTarget(element, target)}` : ''}`;
      },
    });
  }
}

// ── browser_scroll ──────────────────────────────────────────────────────────

const ScrollArgs = z.object({
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction. Default down. Ignored when ref/selector is given.').optional(),
  amount: z.number().int().min(1).max(100_000).describe('Pixels to scroll. Default ~80% of the viewport.').optional(),
  ref: refField(),
  selector: z.string().describe('Scroll this element into view instead of scrolling by an amount.').optional(),
  snapshot: snapshotField(),
});

const SCROLL_POS_EXPR =
  '(() => { const d = document.scrollingElement || document.documentElement; return { x: Math.round(window.scrollX), y: Math.round(window.scrollY), h: d.scrollHeight, w: d.scrollWidth, vh: window.innerHeight, vw: window.innerWidth }; })()';

export class BrowserScrollTool extends Tool<z.infer<typeof ScrollArgs>> {
  name = 'browser_scroll';
  description = 'Scroll the page (direction + amount) or scroll an element into view (ref/selector). Use to reveal lazy-loaded content, then browser_snapshot. Reports the new scroll position.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = ScrollArgs;

  async execute(args: z.infer<typeof ScrollArgs>, ctx: ToolContext): Promise<ToolResult> {
    const target = targetOf(args);
    const direction = args.direction ?? 'down';
    return runBrowserAction({
      tool: 'browser_scroll',
      ctx,
      target,
      snapshot: args.snapshot,
      recordArgs: target ? { ...target } : { direction, ...(args.amount ? { amount: args.amount } : {}) },
      perform: async ({ page, locator, element, timeout }) => {
        if (locator) {
          await locator.scrollIntoViewIfNeeded({ timeout });
          return `✓ Scrolled ${describeTarget(element, target)} into view`;
        }
        const before = await page.evaluate(SCROLL_POS_EXPR);
        const vp = page.viewportSize?.() ?? { width: before.vw, height: before.vh };
        const amount = args.amount ?? Math.round((direction === 'up' || direction === 'down' ? vp.height : vp.width) * 0.8);
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
        await page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
        await page.mouse.wheel(dx, dy);
        await new Promise(r => setTimeout(r, 300));
        const after = await page.evaluate(SCROLL_POS_EXPR);
        const moved = after.x !== before.x || after.y !== before.y;
        const pct = after.h > after.vh ? Math.round((100 * (after.y + after.vh)) / after.h) : 100;
        return moved
          ? `✓ Scrolled ${direction} ${amount}px — now at y=${after.y} of ${after.h}px (${Math.min(100, pct)}% seen)`
          : `✓ Scrolled ${direction} ${amount}px — the page did not move (already at the ${direction === 'up' ? 'top' : direction === 'down' ? 'bottom' : 'edge'}, or the content scrolls inside a panel: pass the ref of an element in that panel)`;
      },
    });
  }
}

// ── browser_drag ────────────────────────────────────────────────────────────

const DragArgs = z.object({
  from_ref: z.string().describe('Ref of the element to drag.').optional(),
  to_ref: z.string().describe('Ref of the drop target.').optional(),
  from_selector: z.string().describe('Selector of the element to drag (when no from_ref).').optional(),
  to_selector: z.string().describe('Selector of the drop target (when no to_ref).').optional(),
  timeout_ms: timeoutField(),
  snapshot: snapshotField(),
});

export class BrowserDragTool extends Tool<z.infer<typeof DragArgs>> {
  name = 'browser_drag';
  description = 'Drag one element onto another (by refs, or selectors) — sortable lists, kanban boards, sliders, drop zones.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = DragArgs;

  async execute(args: z.infer<typeof DragArgs>, ctx: ToolContext): Promise<ToolResult> {
    const from = targetOf({ ref: args.from_ref, selector: args.from_selector });
    const to = targetOf({ ref: args.to_ref, selector: args.to_selector });
    if (!from || !to) return { content: '[BROWSER_ERROR] browser_drag needs from_ref (or from_selector) and to_ref (or to_selector).', isError: true };
    return runBrowserAction({
      tool: 'browser_drag',
      ctx,
      target: from,
      snapshot: args.snapshot,
      timeoutMs: args.timeout_ms,
      recordArgs: { from_ref: from.ref, from_selector: from.selector, to_ref: to.ref, to_selector: to.selector },
      perform: async ({ mgr, locator, element, timeout }) => {
        const toLoc = await mgr.locator(to);
        const toEl = asQodex(mgr) ? await asQodex(mgr)!.describeLocator(toLoc) : null;
        await locator.dragTo(toLoc, { timeout });
        return `✓ Dragged ${describeTarget(element, from)} onto ${describeTarget(toEl, to)}`;
      },
    });
  }
}

// ── browser_upload ──────────────────────────────────────────────────────────

const UploadArgs = z.object({
  ref: refField(),
  selector: selectorField(),
  paths: z.array(z.string()).min(1).describe('Local file paths (relative to the working directory) to upload.'),
  timeout_ms: timeoutField(),
  snapshot: snapshotField(),
});

export class BrowserUploadTool extends Tool<z.infer<typeof UploadArgs>> {
  name = 'browser_upload';
  description =
    'Upload local file(s): target a file input or the page\'s upload button (by ref/selector — a button opens the file chooser which is answered automatically). ' +
    'Without a target, uses the page\'s only file input.';
  isReadOnly = false;
  isDestructive = true; // sends local files to a website
  untrustedOutput = true;
  argsSchema = UploadArgs;

  async execute(args: z.infer<typeof UploadArgs>, ctx: ToolContext): Promise<ToolResult> {
    const files: string[] = [];
    let extraDirs: string[] = [];
    try { const qm = asQodex(await getBrowserManager()); if (qm) extraDirs = [qm.profilesDir]; } catch { /* no manager */ }
    for (const p of args.paths) {
      const abs = resolveUserPath(p, ctx.cwd);
      // Real path too: a symlink must not smuggle the vault key / a profile out.
      if (await isProtectedQodexPathReal(abs, extraDirs)) {
        return { content: `[BROWSER_ERROR] Refusing to upload QodeX credential / browser-profile files (${p}).`, isError: true };
      }
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) return { content: `[BROWSER_ERROR] Not a file: ${p}`, isError: true };
      } catch {
        return { content: `[BROWSER_ERROR] File not found: ${p} (resolved to ${abs})`, isError: true };
      }
      files.push(abs);
    }
    const target = targetOf(args);
    return runBrowserAction({
      tool: 'browser_upload',
      ctx,
      target,
      snapshot: args.snapshot,
      timeoutMs: args.timeout_ms,
      recordArgs: { ...target, paths: files },
      perform: async ({ page, locator, element, timeout }) => {
        const names = files.map(f => path.basename(f)).join(', ');
        if (!locator) {
          const inputs = page.locator('input[type=file]');
          const n = await inputs.count();
          if (n === 0) throw new Error('[BROWSER_ERROR] No file input on this page — pass the ref of the upload button.');
          if (n > 1) throw new Error(`[BROWSER_ERROR] ${n} file inputs on this page — pass the ref/selector of the right one.`);
          await inputs.first().setInputFiles(files, { timeout });
          return `✓ Uploaded ${names} to the page's file input`;
        }
        if (element?.tag === 'input' && element.inputType === 'file') {
          await locator.setInputFiles(files, { timeout });
        } else {
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout }),
            locator.click({ timeout }),
          ]);
          await chooser.setFiles(files);
        }
        return `✓ Uploaded ${names} via ${describeTarget(element, target)}`;
      },
    });
  }
}

// ── browser_history ─────────────────────────────────────────────────────────

const HistoryArgs = z.object({
  action: z.enum(['back', 'forward', 'reload']).describe('Go back, go forward, or reload the active tab.'),
  snapshot: snapshotField(),
});

export class BrowserHistoryTool extends Tool<z.infer<typeof HistoryArgs>> {
  name = 'browser_history';
  description = 'Go back / forward in the active tab\'s history, or reload it.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = HistoryArgs;

  async execute(args: z.infer<typeof HistoryArgs>, ctx: ToolContext): Promise<ToolResult> {
    return runBrowserAction({
      tool: 'browser_history',
      ctx,
      snapshot: args.snapshot,
      recordArgs: { action: args.action },
      perform: async ({ page }) => {
        const opts = { waitUntil: 'domcontentloaded', timeout: 15_000 };
        try {
          if (args.action === 'back') {
            const r = await page.goBack(opts);
            if (r === null && !page.url()) return '✓ No previous page in this tab\'s history';
          } else if (args.action === 'forward') {
            await page.goForward(opts);
          } else {
            await page.reload(opts);
          }
        } catch (e) {
          if (!/timeout/i.test(firstLine(e))) throw e;
        }
        return `✓ ${args.action === 'reload' ? 'Reloaded' : args.action === 'back' ? 'Went back' : 'Went forward'}`;
      },
    });
  }
}

// ── browser_tabs ────────────────────────────────────────────────────────────

const TabsArgs = z.object({
  action: z.enum(['list', 'new', 'switch', 'close']).describe('list tabs, open a new tab (optionally at url), switch to a tab by index, or close one (default: the active tab).'),
  index: z.number().int().min(0).describe('Tab index for switch/close (from action=list).').optional(),
  url: z.string().describe('URL for action=new.').optional(),
  snapshot: snapshotField(),
});

export class BrowserTabsTool extends Tool<z.infer<typeof TabsArgs>> {
  name = 'browser_tabs';
  description = 'Manage tabs of the QodeX browser: list, new (with optional url), switch (index), close (index, default active). Popups opened by a click become the active tab automatically.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = TabsArgs;

  coerceArgs(raw: unknown): unknown {
    if (raw && typeof raw === 'object' && typeof (raw as any).url === 'string' && (raw as any).url.trim()) {
      return { ...(raw as any), url: normalizeUrl((raw as any).url) };
    }
    return raw;
  }

  async execute(args: z.infer<typeof TabsArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      const qm = asQodex(mgr);
      const list = async (): Promise<string> => {
        await qm?.refreshTitles();
        const tabs = mgr.tabs();
        if (!tabs.length) return 'No tabs open.';
        return tabs.map(t => `${t.active ? '*' : ' '} [${t.index}] ${t.title || '(untitled)'} — ${t.url || 'about:blank'}`).join('\n');
      };
      if (args.action === 'list') {
        if (!mgr.isRunning()) return { content: 'The QodeX browser is not running (no tabs). browser_navigate opens it.' };
        return { content: `Tabs (* = active):\n${await list()}` };
      }
      await waitForHuman(mgr, ctx);
      throwIfAborted(ctx.signal);
      let line: string;
      if (args.action === 'new') {
        const url = args.url ? normalizeUrl(args.url) : undefined;
        if (url && await isProtectedFileUrlReal(url, qm ? [qm.profilesDir] : [])) return { content: '[BROWSER_ERROR] Refusing to open QodeX browser-profile / vault files in the browser.', isError: true };
        const info = await withAbort(mgr.newTab(url), ctx.signal);
        if (url) mgr.recordAction({ tool: 'browser_navigate', args: { url, new_tab: true }, url: info.url, title: info.title, actor: 'agent' });
        line = `✓ Opened tab [${info.index}]${url ? ` at ${info.url}` : ''} (now active)`;
      } else if (args.action === 'switch') {
        if (args.index === undefined) return { content: '[BROWSER_ERROR] action=switch needs `index` (see action=list).', isError: true };
        if (!mgr.isRunning()) return notRunningResult();
        const info = await mgr.switchTab(args.index);
        line = `✓ Switched to tab [${info.index}] ${info.title || ''} — ${info.url}`;
      } else {
        if (!mgr.isRunning()) return notRunningResult();
        const idx = args.index ?? mgr.tabs().find(t => t.active)?.index;
        await mgr.closeTab(args.index);
        line = `✓ Closed tab [${idx ?? '?'}]`;
      }
      const content = await composeActionResult(mgr, [line, '', `Tabs (* = active):\n${await list()}`], null, args.snapshot);
      return { content, metadata: { tabs: mgr.tabs().length } };
    } catch (e) {
      return browserErrorResult(e, `tabs ${args.action}`);
    }
  }
}

// ── browser_extract ─────────────────────────────────────────────────────────

const ExtractArgs = z.object({
  format: z.enum(['markdown', 'text', 'links', 'tables', 'metadata']).describe(
    'markdown = readable page content (headings, lists, links, tables; nav/footer skipped); text = plain visible text; ' +
    'links = every link as [text](url); tables = all tables as markdown; metadata = title, description, og:*, canonical, lang, h1. Default markdown.',
  ).optional(),
  selector: z.string().describe('Only this part of the page (Playwright selector), e.g. "article" or "#results".').optional(),
  max_chars: z.number().int().min(200).max(200_000).describe('Truncate output. Default 20000.').optional(),
});

export class BrowserExtractTool extends Tool<z.infer<typeof ExtractArgs>> {
  name = 'browser_extract';
  description = 'Extract the active tab\'s content for reading or saving: markdown, plain text, links, tables or metadata (optionally from one section). Better than browser_get_text for articles, search results and data tables.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = ExtractArgs;

  async execute(args: z.infer<typeof ExtractArgs>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      if (!mgr.isRunning()) return notRunningResult();
      const page = await mgr.activePage();
      const format: ExtractFormat = args.format ?? 'markdown';
      const r = await extractContent(page, { format, selector: args.selector, maxChars: args.max_chars ?? 20_000 });
      let title = '';
      try { title = String(await page.title()); } catch { /* ignore */ }
      const header = `Page: ${title || '(untitled)'}\nURL: ${mgr.activeUrl()}\nFormat: ${format}${args.selector ? ` (selector ${args.selector})` : ''} — ${r.length} chars`;
      return {
        content: `${header}\n\n${r.content || '(nothing found)'}`,
        metadata: { url: mgr.activeUrl(), length: r.length, truncated: r.truncated, format },
      };
    } catch (e) {
      return browserErrorResult(e, 'extract');
    }
  }
}

// ── browser_network ─────────────────────────────────────────────────────────

const NetworkArgs = z.object({
  filter: z.string().describe('Only requests whose URL contains this text (case-insensitive).').optional(),
  failed_only: z.boolean().describe('Only failed requests (network errors and HTTP >= 400).').optional(),
  limit: z.number().int().min(1).max(500).describe('Max entries, newest last. Default 50.').optional(),
});

export class BrowserNetworkTool extends Tool<z.infer<typeof NetworkArgs>> {
  name = 'browser_network';
  description = 'Network requests of the active tab since its last browser_navigate (method, status, type, URL; failures with their error). Use to debug API calls / failed loads.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = NetworkArgs;

  async execute(args: z.infer<typeof NetworkArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const mgr = await getBrowserManager();
    const bufs = asQodex(mgr)?.activeBuffers();
    if (!mgr.isRunning() || !bufs) return { content: 'The QodeX browser is not running — no requests recorded.' };
    const f = args.filter?.toLowerCase();
    let rows = bufs.requests.filter(r => !f || r.url.toLowerCase().includes(f));
    if (args.failed_only) rows = rows.filter(r => r.ok === false || (r.status !== undefined && r.status >= 400));
    const limit = args.limit ?? 50;
    const slice = rows.slice(-limit);
    const fmt = (r: (typeof rows)[number]) => {
      const st = r.failure ? `FAIL ${r.failure}` : r.status !== undefined ? String(r.status) : '…';
      const u = r.url.length > 200 ? r.url.slice(0, 200) + '…' : r.url;
      return `  [${st}] ${r.method} ${u}${r.resourceType ? `  (${r.resourceType})` : ''}`;
    };
    return {
      content: `Requests (${slice.length}/${rows.length}${args.failed_only ? ' failed' : ''}${f ? ` matching "${args.filter}"` : ''}):\n${slice.length ? slice.map(fmt).join('\n') : '  (none)'}`,
    };
  }
}

// ── browser_downloads ───────────────────────────────────────────────────────

const DownloadsArgs = z.object({
  action: z.enum(['list', 'wait']).describe('list = downloads of this session; wait = wait for the current/next download to finish.'),
  timeout_ms: z.number().int().min(100).max(600_000).describe('For wait: max wait in ms. Default 30000.').optional(),
});

export class BrowserDownloadsTool extends Tool<z.infer<typeof DownloadsArgs>> {
  name = 'browser_downloads';
  description = 'Files downloaded by the QodeX browser (saved to ~/.qodex/browser/downloads): list them, or wait for a download triggered by a click to finish and get its path.';
  // Not read-only: `wait` must run AFTER the click that triggers the download in the same response.
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  timeoutSeconds = 660;
  argsSchema = DownloadsArgs;

  async execute(args: z.infer<typeof DownloadsArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      const qm = asQodex(mgr);
      if (!qm) return { content: '[BROWSER_ERROR] downloads need the QodeX browser manager.', isError: true };
      const fmt = (d: ReturnType<typeof qm.downloads>[number]) =>
        `  [${d.state}] ${d.path || d.suggestedFilename}${d.bytes !== undefined ? ` (${formatBytes(d.bytes)})` : ''}${d.error ? ` — ${d.error}` : ''}\n      from ${d.url.length > 160 ? d.url.slice(0, 160) + '…' : d.url}`;
      if (args.action === 'list') {
        const list = qm.downloads();
        return { content: `Downloads (${list.length}) — folder ${qm.downloadsDir || QODEX_BROWSER_DOWNLOADS_DIR}:\n${list.length ? list.map(fmt).join('\n') : '  (none yet)'}` };
      }
      if (!mgr.isRunning() && !qm.downloads().some(d => d.state === 'in_progress')) return notRunningResult();
      const timeout = args.timeout_ms ?? 30_000;
      ctx.emit({ type: 'progress', message: `Waiting up to ${Math.round(timeout / 1000)}s for a download…` });
      const d = await qm.waitForDownload(timeout, ctx.signal);
      const notes = qm.drainNotices().filter(n => !/^Download /.test(n)).map(n => `• ${n}`);
      if (!d) return { content: [`[BROWSER_ERROR] No download finished within ${timeout} ms. Click the download link/button first (or raise timeout_ms).`, ...notes].join('\n'), isError: true };
      return {
        content: [d.state === 'completed' ? `✓ Download finished: ${d.path} (${formatBytes(d.bytes ?? 0)})` : `[BROWSER_ERROR] Download failed: ${d.suggestedFilename} — ${d.error ?? 'unknown error'}`, ...notes].join('\n'),
        isError: d.state !== 'completed',
        metadata: { path: d.path, bytes: d.bytes, state: d.state },
      };
    } catch (e) {
      return browserErrorResult(e, 'downloads');
    }
  }
}

// ── browser_dialog ──────────────────────────────────────────────────────────

const DialogArgs = z.object({
  action: z.enum(['accept', 'dismiss', 'status']).describe('Answer the waiting JavaScript dialog (alert/confirm/prompt), or show dialog status/history.'),
  text: z.string().describe('Text to enter for a prompt() dialog when accepting.').optional(),
});

export class BrowserDialogTool extends Tool<z.infer<typeof DialogArgs>> {
  name = 'browser_dialog';
  description = 'Handle JavaScript dialogs (alert / confirm / prompt) when browser.dialogPolicy is "ask": accept (optionally with text) or dismiss the waiting one; status lists recent dialogs.';
  isReadOnly = false;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = DialogArgs;

  async execute(args: z.infer<typeof DialogArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      const qm = asQodex(mgr);
      if (!qm) return { content: '[BROWSER_ERROR] dialogs need the QodeX browser manager.', isError: true };
      if (args.action === 'status') {
        const pending = qm.pendingDialog();
        const recent = qm.dialogs().slice(-10);
        const lines = [
          `Dialog policy: ${qm.currentConfig().dialogPolicy}`,
          pending ? `Waiting: (${pending.type}) "${pending.message}"${pending.defaultValue ? ` [default: ${pending.defaultValue}]` : ''}` : 'Waiting: none',
          `Recent (${recent.length}):`,
          ...(recent.length ? recent.map(d => `  ${d.action.padEnd(14)} (${d.type}) "${d.message.slice(0, 160)}" — ${d.url}`) : ['  (none)']),
        ];
        return { content: lines.join('\n') };
      }
      await waitForHuman(mgr, ctx);
      const entry = await qm.resolveDialog(args.action, args.text);
      if (!entry) return { content: '[BROWSER_ERROR] No dialog is waiting for an answer.', isError: true };
      const line = `✓ ${args.action === 'accept' ? 'Accepted' : 'Dismissed'} ${entry.type} "${entry.message.slice(0, 200)}"${args.text !== undefined && args.action === 'accept' ? ` with "${args.text}"` : ''}`;
      await qm.settle();
      return { content: await composeActionResult(mgr, [line], null, undefined) };
    } catch (e) {
      return browserErrorResult(e, 'dialog');
    }
  }
}

// ── browser_pdf ─────────────────────────────────────────────────────────────

const PdfArgs = z.object({
  path: z.string().describe('Where to save the PDF (relative to the working directory). Default ~/.qodex/browser/downloads/page-<time>.pdf.').optional(),
});

export class BrowserPdfTool extends Tool<z.infer<typeof PdfArgs>> {
  name = 'browser_pdf';
  description = 'Save the active tab as a PDF (print layout, backgrounds included). Works in headless mode.';
  isReadOnly = false;
  isDestructive = false;
  argsSchema = PdfArgs;

  async execute(args: z.infer<typeof PdfArgs>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mgr = await getBrowserManager();
      if (!mgr.isRunning()) return notRunningResult();
      const st = mgr.status();
      if (!st.headless) return { content: '[BROWSER_ERROR] PDF export only works in a headless browser. Use browser_screenshot full_page=true instead, or run headless.', isError: true };
      const dir = asQodex(mgr)?.downloadsDir ?? QODEX_BROWSER_DOWNLOADS_DIR;
      const dest = args.path ? resolveUserPath(args.path, ctx.cwd) : path.join(dir, `page-${Date.now()}.pdf`);
      const bad = await checkOutputPath(dest, ['.pdf'], mgr);
      if (bad) return { content: `[BROWSER_ERROR] pdf: ${bad}`, isError: true };
      const page = await mgr.activePage();
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await withAbort(page.pdf({ path: dest, printBackground: true }), ctx.signal);
      const stat = await fs.stat(dest);
      return { content: `✓ PDF saved: ${dest} (${formatBytes(stat.size)}) — ${mgr.activeUrl()}`, metadata: { path: dest, bytes: stat.size } };
    } catch (e) {
      return browserErrorResult(e, 'pdf');
    }
  }
}

// ── browser_status ──────────────────────────────────────────────────────────

const StatusArgs = z.object({});

export class BrowserStatusTool extends Tool<z.infer<typeof StatusArgs>> {
  name = 'browser_status';
  description = 'State of the QodeX browser without launching it: running or not, profile, headless/headed, tabs, human takeover, pending dialog, downloads folder.';
  // Read-only: pure manager state; never launches the browser or touches a page.
  isReadOnly = true;
  isDestructive = false;
  untrustedOutput = true;
  argsSchema = StatusArgs;

  async execute(_args: z.infer<typeof StatusArgs>, _ctx: ToolContext): Promise<ToolResult> {
    const mgr = await getBrowserManager();
    const s = mgr.status() as ReturnType<typeof mgr.status> & { executableSource?: string; notice?: string; pendingDialog?: { type: string; message: string }; cdpUrl?: string; downloads?: number };
    const lines = [
      `Running: ${s.running ? 'yes' : 'no'}${s.running ? ` (${s.mode === 'cdp' ? `attached to your Chrome${s.cdpUrl ? ` at ${s.cdpUrl}` : ''}` : s.headless ? 'headless' : 'visible window'})` : ''}`,
      `Profile: ${s.profile} (logins persist between runs)`,
      `Browser: ${s.executable ?? '(auto)'}${s.executableSource ? ` [${s.executableSource}]` : ''}${s.version ? ` v${s.version}` : ''}`,
      `Human takeover: ${s.takeover ? `ON${s.takeoverBy ? ` by ${s.takeoverBy}` : ''} — actions wait until it is handed back` : 'off'}`,
      `Downloads: ${s.downloads ?? 0} → ${s.downloadsDir}`,
    ];
    if (s.pendingDialog) lines.push(`Dialog waiting: (${s.pendingDialog.type}) "${s.pendingDialog.message.slice(0, 160)}"`);
    if (s.notice) lines.push(`Note: ${s.notice}`);
    if (s.running) {
      lines.push(`Tabs (${s.tabs.length}, * = active):`);
      for (const t of s.tabs) lines.push(`${t.active ? '*' : ' '} [${t.index}] ${t.title || '(untitled)'} — ${t.url || 'about:blank'}`);
    }
    return { content: lines.join('\n'), metadata: { running: s.running, tabs: s.tabs.length } };
  }
}
