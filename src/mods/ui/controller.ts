/**
 * The TUI side of mods, without React: follows the mods host's UI bus, keeps what the
 * screen shows (band trees, panes, status lines, toasts, spinner suffix), runs the
 * `ui.render` hooks at most 10 times a second, validates every tree, and owns keyboard
 * focus for panes (Ctrl+X Tab focuses, Tab/arrows move between Buttons, Enter or a
 * Button's hotkey presses it, Esc gives the keyboard back to the prompt).
 *
 * The React layer (components.tsx) only reads getSnapshot(); ui.tsx forwards keys to
 * handleInput() and history lines arrive through `onHistory`. Nothing here ever reaches
 * the model: log and notice lines are display-only history entries.
 */

import type { Key } from 'ink';
import { MOD_LIMITS, type ModElement, type ModRenderSite, type ModSurface } from '../types.js';
import { getModsUiHost, onModsUiHostChange, type ModRenderOutput, type ModRenderRequest, type ModsUiHost, type ModUiEvent } from './host.js';
import { cleanText, collectButtons, validateModTree, type ModButtonRef } from './validate.js';

export interface ModHistoryLine { kind: 'log' | 'notice' | 'error'; plugin: string; text: string }

export type ModsFocus = { kind: 'pane'; id: string } | { kind: 'band' };

export interface ModPaneView {
  id: string;
  plugin: string;
  title: string;
  /** Height the mod asked for (rows of body), if any. */
  rows?: number;
  closeOnEscape?: boolean;
  /** The validated tree, or null when the pane has nothing (yet) or its tree was refused. */
  tree: ModElement | null;
}

export interface ModsUiSnapshot {
  band: Array<{ plugin: string; tree: ModElement }>;
  panes: ModPaneView[];
  /** The pane whose body is shown (tabs when several are open). */
  activePane: string | null;
  statuses: Array<{ plugin: string; text: string }>;
  toasts: Array<{ id: number; plugin: string; text: string }>;
  /** Spinner site: a suffix after QodeX's word, or a tree drawn in its place. */
  spinner: { suffix?: string; tree?: ModElement } | null;
  focus: ModsFocus | null;
  /** Key of the focused Button inside the focused region. */
  focusedKey: string | null;
  /** The mod that drew the focused Button (band buttons of two mods may share a key). */
  focusedPlugin: string | null;
  /**
   * Ctrl+X was just pressed and the next key belongs to the chord (Tab focuses a pane,
   * X closes one). The TUI keeps that key out of the prompt box while this is set.
   */
  chord: boolean;
}

export interface ModsUiContext {
  busy: boolean;
  columns: number;
  rows: number;
  /** The prompt box is empty — a pane may take the keyboard on open only then. */
  promptEmpty: boolean;
  mode?: string;
}

interface FocusButton extends ModButtonRef { plugin: string; component: ModRenderSite; requestId?: string }

const EMPTY: ModsUiSnapshot = Object.freeze({
  band: [], panes: [], activePane: null, statuses: [], toasts: [], spinner: null, focus: null, focusedKey: null, focusedPlugin: null, chord: false,
}) as ModsUiSnapshot;

const REDRAW_MS = Math.ceil(1000 / MOD_LIMITS.redrawPerSecond);
const CHORD_MS = 1500;
const MAX_TOASTS = 3;
const MAX_STATUS_CHARS = 300;
const MAX_LINE_CHARS = 2000;
/** Distinct refusal lines per mod and site before the rest are kept quiet. */
const MAX_REFUSAL_LINES = 3;

export interface ModsUiControllerOptions {
  /** A log/notice line (or a refused-tree line) for the transcript. */
  onHistory: (line: ModHistoryLine) => void;
  /** $.prompt.submit from a mod: queue it as the next prompt. Without it, prompts are dropped. */
  onPrompt?: (p: { plugin: string; text: string; asUser: boolean }) => void;
  surface?: ModSurface;
  now?: () => number;
}

export class ModsUiController {
  private host: ModsUiHost | null = null;
  private unsubBus: (() => void) | null = null;
  private snap: ModsUiSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private ctx: ModsUiContext = { busy: false, columns: 80, rows: 24, promptEmpty: true };
  private readonly statuses = new Map<string, string>();
  private panes: Array<Omit<ModPaneView, 'tree'>> = [];
  private paneTrees = new Map<string, ModElement | null>();
  private band: Array<{ plugin: string; tree: ModElement }> = [];
  private spinner: ModsUiSnapshot['spinner'] = null;
  private toasts: Array<{ id: number; plugin: string; text: string }> = [];
  private readonly toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private toastSeq = 0;
  private activePane: string | null = null;
  private focus: ModsFocus | null = null;
  private focusedKey: string | null = null;
  private focusedPlugin: string | null = null;
  private readonly refused = new Set<string>();
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private rendering = false;
  private renderAgain = false;
  private lastRenderAt = 0;
  private chordUntil = 0;
  private chordTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the last render pass drew (functions left out), to skip identical repaints. */
  private lastViewSig = '';
  private disposed = false;
  private wakeQueued = false;
  private readonly surface: ModSurface;
  private readonly now: () => number;

  constructor(private readonly opts: ModsUiControllerOptions) {
    this.surface = opts.surface ?? 'terminal';
    this.now = opts.now ?? Date.now;
  }

  // ── wiring ──────────────────────────────────────────────────────────────────

  /** Follow the registered host (now and whenever it changes). Returns the stop function. */
  start(): () => void {
    this.disposed = false;
    this.attach(getModsUiHost());
    const off = onModsUiHostChange(h => this.attach(h));
    return () => { off(); this.dispose(); };
  }

  /** Use this host's bus and render chain (null = mods off: everything empties). */
  attach(host: ModsUiHost | null): void {
    if (host === this.host) return;
    try { this.unsubBus?.(); } catch { /* ignore */ }
    this.unsubBus = null;
    this.host = host;
    this.statuses.clear();
    this.panes = [];
    this.paneTrees.clear();
    this.band = [];
    this.spinner = null;
    this.activePane = null;
    this.focus = null;
    this.setFocused(null);
    this.refused.clear();
    this.lastViewSig = '';
    if (host) {
      try {
        this.unsubBus = host.subscribe(ev => this.onBus(ev));
      } catch {
        this.unsubBus = null;
      }
    }
    this.publish();
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    try { this.unsubBus?.(); } catch { /* ignore */ }
    this.unsubBus = null;
    this.host = null;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    if (this.chordTimer) clearTimeout(this.chordTimer);
    this.chordTimer = null;
    this.chordUntil = 0;
    for (const t of this.toastTimers.values()) clearTimeout(t);
    this.toastTimers.clear();
  }

  /** Busy state, terminal size and prompt emptiness from the TUI. Redraws when it matters. */
  setContext(next: Partial<ModsUiContext>): void {
    const prev = this.ctx;
    this.ctx = { ...prev, ...next };
    if (prev.busy !== this.ctx.busy || prev.columns !== this.ctx.columns || prev.rows !== this.ctx.rows || prev.mode !== this.ctx.mode) {
      this.invalidate();
    }
  }

  // ── React binding ──────────────────────────────────────────────────────────

  getSnapshot = (): ModsUiSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(): void {
    this.snap = {
      band: this.band,
      panes: this.panes.map(p => ({ ...p, tree: this.paneTrees.get(p.id) ?? null })),
      activePane: this.activePane,
      statuses: [...this.statuses].map(([plugin, text]) => ({ plugin, text })),
      toasts: this.toasts,
      spinner: this.spinner,
      focus: this.focus,
      focusedKey: this.focusedKey,
      focusedPlugin: this.focusedPlugin,
      chord: this.chordUntil > 0,
    };
    // Wake React once per burst. Ink renders on a legacy root, so every listener call
    // outside its own input batch is a full synchronous App render: a mod calling
    // $.ui.status in a loop, or the bus replaying its backlog, would otherwise paint
    // once per event. The snapshot itself is current at once; only the wake waits for
    // the end of the current task (still before the next keypress is read).
    if (this.wakeQueued) return;
    this.wakeQueued = true;
    queueMicrotask(() => {
      this.wakeQueued = false;
      for (const l of [...this.listeners]) {
        try { l(); } catch { /* ignore */ }
      }
    });
  }

  // ── the bus ────────────────────────────────────────────────────────────────

  private onBus(ev: ModUiEvent): void {
    if (this.disposed || !ev || typeof ev !== 'object') return;
    switch (ev.kind) {
      case 'status': {
        const text = typeof ev.text === 'string' ? oneLine(ev.text, MAX_STATUS_CHARS) : '';
        if (text) this.statuses.set(ev.plugin, text);
        else this.statuses.delete(ev.plugin);
        this.publish();
        return;
      }
      case 'toast':
        this.addToast(ev.plugin, ev.text, ev.timeoutMs);
        return;
      case 'log':
      case 'notice':
      case 'error': {
        const text = cleanText(String(ev.text ?? '')).trim().slice(0, MAX_LINE_CHARS);
        if (text) this.history({ kind: ev.kind, plugin: ev.plugin, text });
        return;
      }
      case 'open':
      case 'pane.open':
        this.openPane(ev);
        return;
      case 'close':
      case 'pane.close':
        this.removePane(ev.id, false);
        return;
      case 'prompt': {
        const text = String(ev.text ?? '').trim();
        if (!text) return;
        try { this.opts.onPrompt?.({ plugin: ev.plugin, text, asUser: ev.asUser === true }); } catch { /* ignore */ }
        return;
      }
      case 'invalidate':
        this.invalidate();
        return;
      case 'unload':
        this.unloadPlugin(ev.plugin);
        return;
    }
  }

  private history(line: ModHistoryLine): void {
    try { this.opts.onHistory(line); } catch { /* the transcript is best effort */ }
  }

  private addToast(plugin: string, rawText: string, timeoutMs?: number): void {
    const text = oneLine(String(rawText ?? ''), MAX_STATUS_CHARS);
    if (!text) return;
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, plugin, text }];
    while (this.toasts.length > MAX_TOASTS) this.dropToast(this.toasts[0]!.id, false);
    const ms = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.min(60_000, Math.max(500, timeoutMs))
      : MOD_LIMITS.toastMs;
    const timer = setTimeout(() => this.dropToast(id, true), ms);
    (timer as { unref?: () => void }).unref?.();
    this.toastTimers.set(id, timer);
    this.publish();
  }

  private dropToast(id: number, publish: boolean): void {
    const t = this.toastTimers.get(id);
    if (t) clearTimeout(t);
    this.toastTimers.delete(id);
    this.toasts = this.toasts.filter(x => x.id !== id);
    if (publish) this.publish();
  }

  private openPane(ev: Extract<ModUiEvent, { kind: 'open' | 'pane.open' }>): void {
    if (typeof ev.id !== 'string' || !MOD_LIMITS.nameRe.test(ev.id)) return;
    const pane = {
      id: ev.id,
      plugin: ev.plugin,
      title: typeof ev.title === 'string' && ev.title.trim() ? oneLine(ev.title, 60) : ev.id,
      ...(typeof ev.rows === 'number' && ev.rows > 0 ? { rows: Math.min(200, Math.floor(ev.rows)) } : {}),
      ...(ev.closeOnEscape === true ? { closeOnEscape: true } : {}),
    };
    const at = this.panes.findIndex(p => p.id === ev.id);
    this.panes = at >= 0 ? this.panes.map((p, i) => (i === at ? pane : p)) : [...this.panes, pane];
    this.activePane = ev.id;
    // Take the keyboard only when asked, the prompt is empty and nothing else has it.
    if (ev.focus === true && this.ctx.promptEmpty && !this.focus) {
      this.focus = { kind: 'pane', id: ev.id };
      this.setFocused(null);
    }
    this.publish();
    this.invalidate();
  }

  private removePane(id: string, byUser: boolean): void {
    const pane = this.panes.find(p => p.id === id);
    if (!pane) return;
    this.panes = this.panes.filter(p => p.id !== id);
    this.paneTrees.delete(id);
    this.lastViewSig = '';
    if (this.activePane === id) this.activePane = this.panes.length ? this.panes[this.panes.length - 1]!.id : null;
    if (this.focus?.kind === 'pane' && this.focus.id === id) { this.focus = null; this.setFocused(null); }
    if (byUser) {
      try { this.host?.paneClosed?.({ plugin: pane.plugin, id }); } catch { /* ignore */ }
    }
    this.publish();
    this.invalidate();
  }

  private unloadPlugin(plugin: string): void {
    this.statuses.delete(plugin);
    for (const p of this.panes.filter(x => x.plugin === plugin)) this.removePane(p.id, false);
    this.band = this.band.filter(b => b.plugin !== plugin);
    this.lastViewSig = '';
    for (const t of this.toasts.filter(x => x.plugin === plugin)) this.dropToast(t.id, false);
    for (const k of [...this.refused]) if (k.startsWith(`${plugin}\u0000`)) this.refused.delete(k);
    this.publish();
    this.invalidate();
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  /** Run the ui.render hooks again soon — at most REDRAW_MS apart, never two at once. */
  invalidate(): void {
    if (this.disposed) return;
    if (this.rendering) { this.renderAgain = true; return; }
    if (this.renderTimer) return;
    const wait = Math.max(0, this.lastRenderAt + REDRAW_MS - this.now());
    this.renderTimer = setTimeout(() => { void this.runRender(); }, wait);
    (this.renderTimer as { unref?: () => void }).unref?.();
  }

  private async runRender(): Promise<void> {
    this.renderTimer = null;
    if (this.disposed) return;
    this.rendering = true;
    this.lastRenderAt = this.now();
    try {
      await this.renderNow();
    } catch { /* a render pass never throws out of here */ }
    this.rendering = false;
    if (this.renderAgain) {
      this.renderAgain = false;
      this.invalidate();
    }
  }

  /** One render pass over every site (exposed for tests). */
  async renderNow(): Promise<void> {
    const host = this.host;
    if (!host) {
      if (this.band.length || this.spinner || this.paneTrees.size) {
        this.band = []; this.spinner = null; this.paneTrees.clear();
        this.lastViewSig = '';
        this.publish();
      }
      return;
    }
    const { columns, rows, busy } = this.ctx;
    const viewport = { columns, rows };
    const bodyColumns = Math.max(10, columns - 2);
    const call = async (req: ModRenderRequest): Promise<ModRenderOutput> => {
      try {
        const out = await host.renderSite(req);
        return out && Array.isArray(out.trees) ? out : { trees: [] };
      } catch {
        return { trees: [] };
      }
    };
    const panes = [...this.panes];
    const [bandOut, spinnerOut, ...paneOuts] = await Promise.all([
      call({ component: 'AbovePrompt', surface: this.surface, props: { isWorking: busy, maxRows: this.bandMaxRows(), bodyColumns }, viewport }),
      busy
        ? call({ component: 'Spinner', surface: this.surface, props: { word: 'crafting', message: '', suffix: '', mode: this.ctx.mode ?? 'normal' }, viewport })
        : Promise.resolve<ModRenderOutput>({ trees: [] }),
      ...panes.map(p => call({
        component: 'Pane', requestId: p.id, surface: this.surface,
        props: { title: p.title, isFocused: this.focus?.kind === 'pane' && this.focus.id === p.id, bodyColumns: Math.max(10, columns - 4), placement: 'inline' },
        viewport,
      })),
    ]);
    if (this.disposed || host !== this.host) return;

    const band: Array<{ plugin: string; tree: ModElement }> = [];
    for (const t of bandOut!.trees) {
      const tree = this.accept(t.plugin, 'AbovePrompt', t.tree);
      if (tree && tree.type !== 'engine') band.push({ plugin: t.plugin, tree });
    }
    this.band = band;

    panes.forEach((p, i) => {
      if (!this.panes.some(x => x.id === p.id)) return; // closed meanwhile
      const out = paneOuts[i]!;
      const pick = out.trees.find(t => t.plugin === p.plugin) ?? out.trees[0];
      const tree = pick ? this.accept(pick.plugin, 'Pane', pick.tree) : null;
      this.paneTrees.set(p.id, tree && tree.type !== 'engine' ? tree : null);
    });

    this.spinner = busy ? this.spinnerFrom(spinnerOut!) : null;
    const focusBefore = `${JSON.stringify(this.focus)}\u0000${this.focusedPlugin}\u0000${this.focusedKey}`;
    this.fixFocus();
    // Most passes redraw the same thing (a mod invalidating on every tool result): only
    // wake React when what is drawn changed. Button callbacks are read from this.band /
    // this.paneTrees at press time, so a skipped publish never leaves a stale onPress.
    const sig = viewSignature(this.band, this.paneTrees, this.spinner);
    const focusAfter = `${JSON.stringify(this.focus)}\u0000${this.focusedPlugin}\u0000${this.focusedKey}`;
    if (sig !== this.lastViewSig || focusBefore !== focusAfter) {
      this.lastViewSig = sig;
      this.publish();
    }
  }

  private spinnerFrom(out: ModRenderOutput): ModsUiSnapshot['spinner'] {
    // The suffix follows the word as given (a leading space is the mod's spacing).
    const suffix = typeof out.engineProps?.suffix === 'string'
      ? cleanText(out.engineProps.suffix).replace(/\s*\n\s*/g, ' ').trimEnd().slice(0, 120)
      : '';
    const first = out.trees[0];
    if (first) {
      const tree = this.accept(first.plugin, 'Spinner', first.tree);
      if (tree && tree.type !== 'engine') return { tree, ...(suffix ? { suffix } : {}) };
    }
    return suffix ? { suffix } : null;
  }

  /** Validate a tree; a refusal is logged once per mod, site and reason (a few per mod and site). */
  private accept(plugin: string, site: ModRenderSite, tree: unknown): ModElement | null {
    if (tree === null || tree === undefined) return null;
    const r = validateModTree(tree);
    if (r.ok) return r.tree;
    const k = `${plugin}\u0000${site}\u0000${r.reason}`;
    if (!this.refused.has(k)) {
      // A reason can name a mod's own data (a prop or element name), so a mod that
      // spreads a record into props would log a new line on every pass: cap it.
      const site0 = `${plugin}\u0000${site}\u0000`;
      const seen = [...this.refused].filter(x => x.startsWith(site0)).length;
      if (seen > MAX_REFUSAL_LINES) return null;
      this.refused.add(k);
      this.history({
        kind: 'log', plugin,
        text: seen < MAX_REFUSAL_LINES
          ? `ui.render (${site}) refused: ${r.reason}`
          : `ui.render (${site}) refused again; further refusals are not shown until the mod reloads`,
      });
    }
    return null;
  }

  /** Rows the AbovePrompt band may use (a quarter of the terminal). */
  bandMaxRows(): number {
    return Math.max(2, Math.floor(this.ctx.rows / 4));
  }

  /** Rows a pane's body may use above the prompt. */
  paneMaxRows(pane?: { rows?: number }): number {
    const limit = Math.max(3, Math.floor(this.ctx.rows / 3));
    return pane?.rows ? Math.min(pane.rows, Math.max(3, this.ctx.rows - 8)) : limit;
  }

  // ── keyboard ───────────────────────────────────────────────────────────────

  /**
   * A keypress from the TUI. Returns true when mods handled it (the caller then stops).
   * Ctrl+X is only noted, never swallowed, so other Ctrl+X chords keep working.
   */
  handleInput(input: string, key: Partial<Key>): boolean {
    if (this.disposed) return false;
    const now = this.now();
    if (key.ctrl && input === 'x') {
      this.armChord(now);
      return false;
    }
    if (this.chordUntil > now) {
      this.endChord();
      if (key.tab && !key.shift) { this.cycleFocus(); return true; }
      if (!key.ctrl && !key.meta && input === 'x') {
        // Ctrl+X X closes the focused pane. It is the chord's key, never a hotkey: with
        // the band focused it must not press a band Button whose hotkey is x.
        if (this.focus?.kind === 'pane') this.removePane(this.focus.id, true);
        else this.publish();
        return true;
      }
      this.publish(); // the chord is over: the prompt box takes keys again
    } else if (this.chordUntil > 0) {
      this.endChord();
      this.publish();
    }
    const focus = this.focus;
    if (!focus) return false;
    if (input === '\u001b[Z') return false;      // a raw Shift+Tab some terminals send

    if (key.escape) {
      const pane = focus.kind === 'pane' ? this.panes.find(p => p.id === focus.id) : undefined;
      this.focus = null;
      this.setFocused(null);
      if (pane?.closeOnEscape) this.removePane(pane.id, true);
      else this.publish();
      return true;
    }
    if (key.ctrl || key.meta) return false;      // Ctrl+C and friends stay with the app
    if (key.tab && key.shift) return false;     // Shift+Tab cycles the approval mode

    const buttons = this.focusButtons();
    const at = buttons.findIndex(b => this.isFocused(b));
    if (key.tab || key.downArrow || key.rightArrow) { this.moveFocus(buttons, at, +1); return true; }
    if (key.upArrow || key.leftArrow) { this.moveFocus(buttons, at, -1); return true; }
    if (key.return) {
      const b = at >= 0 ? buttons[at] : undefined;
      if (b) void this.press(b);
      return true;
    }
    if (input && input.length === 1) {
      // When two buttons share a hotkey, the later one gets it (as in Claude Code).
      const hit = [...buttons].reverse().find(b => b.hotkey === input);
      if (hit) {
        this.setFocused(hit);
        this.publish();
        void this.press(hit);
      }
      return true;
    }
    return true; // while a pane has the keyboard nothing types into the prompt
  }

  private armChord(now: number): void {
    this.chordUntil = now + CHORD_MS;
    if (this.chordTimer) clearTimeout(this.chordTimer);
    this.chordTimer = setTimeout(() => {
      this.chordTimer = null;
      if (this.chordUntil === 0) return;
      this.chordUntil = 0;
      this.publish();
    }, CHORD_MS);
    (this.chordTimer as { unref?: () => void }).unref?.();
    this.publish();
  }

  private endChord(): void {
    this.chordUntil = 0;
    if (this.chordTimer) clearTimeout(this.chordTimer);
    this.chordTimer = null;
  }

  private focusTargets(): ModsFocus[] {
    const targets: ModsFocus[] = this.panes.map(p => ({ kind: 'pane' as const, id: p.id }));
    if (this.band.some(b => collectButtons(b.tree).length > 0)) targets.push({ kind: 'band' });
    return targets;
  }

  /** Ctrl+X Tab: prompt → first pane → … → band (when it has buttons) → prompt. */
  private cycleFocus(): void {
    const targets = this.focusTargets();
    if (targets.length === 0) {
      this.addToast('mods', 'Nothing to focus — no mod pane is open');
      return;
    }
    const cur = this.focus;
    const i = cur ? targets.findIndex(t => t.kind === cur.kind && (t.kind === 'band' || (cur.kind === 'pane' && t.id === cur.id))) : -1;
    const next = i + 1 < targets.length ? targets[i + 1]! : null;
    this.focus = next;
    this.setFocused(null);
    if (next?.kind === 'pane') this.activePane = next.id;
    this.fixFocus();
    this.publish();
  }

  private focusButtons(): FocusButton[] {
    const f = this.focus;
    if (!f) return [];
    if (f.kind === 'band') {
      return this.band.flatMap(b => collectButtons(b.tree).map(btn => ({ ...btn, plugin: b.plugin, component: 'AbovePrompt' as const })));
    }
    const pane = this.panes.find(p => p.id === f.id);
    if (!pane) return [];
    return collectButtons(this.paneTrees.get(pane.id) ?? null)
      .map(btn => ({ ...btn, plugin: pane.plugin, component: 'Pane' as const, requestId: pane.id }));
  }

  private moveFocus(buttons: FocusButton[], at: number, step: number): void {
    if (buttons.length === 0) return;
    const next = at < 0 ? (step > 0 ? 0 : buttons.length - 1) : (at + step + buttons.length) % buttons.length;
    this.setFocused(buttons[next]!);
    this.publish();
  }

  /** Keep focus pointing at something that exists after a redraw or a close. */
  private fixFocus(): void {
    const f = this.focus;
    if (!f) return;
    if (f.kind === 'pane' && !this.panes.some(p => p.id === f.id)) { this.focus = null; this.setFocused(null); return; }
    const buttons = this.focusButtons();
    if (f.kind === 'band' && buttons.length === 0) { this.focus = null; this.setFocused(null); return; }
    if (!buttons.some(b => this.isFocused(b))) {
      this.setFocused(buttons.find(b => b.autoFocus) ?? buttons[0] ?? null);
    }
  }

  /** The focused Button is named by its mod and key together. */
  private isFocused(b: FocusButton): boolean {
    return b.key === this.focusedKey && b.plugin === this.focusedPlugin;
  }

  private setFocused(b: FocusButton | null): void {
    this.focusedKey = b?.key ?? null;
    this.focusedPlugin = b?.plugin ?? null;
  }

  private async press(b: FocusButton): Promise<void> {
    const host = this.host;
    try {
      if (host) {
        await host.press({ plugin: b.plugin, key: b.key, requestId: b.requestId, component: b.component }, b.onPress);
      } else if (b.onPress) {
        await b.onPress();
      }
    } catch (e) {
      this.history({ kind: 'log', plugin: b.plugin, text: `button "${b.key}" failed: ${(e as Error)?.message ?? String(e)}` });
    }
    this.invalidate();
  }
}

function oneLine(s: string, max: number): string {
  const t = cleanText(s).replace(/\s*\n\s*/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** What a render pass draws, as a string (functions such as onPress leave no trace). */
function viewSignature(
  band: Array<{ plugin: string; tree: ModElement }>,
  paneTrees: Map<string, ModElement | null>,
  spinner: ModsUiSnapshot['spinner'],
): string {
  try {
    return JSON.stringify([band, [...paneTrees], spinner]);
  } catch {
    return String(Math.random()); // unserializable: always redraw
  }
}
