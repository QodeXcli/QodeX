/**
 * The in-process mods UI bus: how $.ui.* calls (and the runtime's own notes) reach a
 * surface. The TUI subscribes and draws; headless prints log / notice / error lines to
 * stderr and ignores the rest. No Ink or React here — this is plain data.
 *
 * Events are delivered synchronously in emit order. Until the first subscriber arrives
 * the bus keeps the newest events (a mod's session.start log line fires before the TUI
 * mounts) and replays them to that subscriber. `invalidate` is coalesced to at most
 * MOD_LIMITS.redrawPerSecond deliveries a second.
 *
 * State a late subscriber needs is also kept here: the current status line of each mod
 * (modStatusLines) and the open panes (modOpenPanes).
 */
import { MOD_LIMITS } from './types.js';

export type ModUiEvent =
  /** One line under the prompt for this mod ("⚠ <mod>: text"); null clears it. */
  | { kind: 'status'; plugin: string; text: string | null }
  /** A short notice at the top that disappears after timeoutMs. */
  | { kind: 'toast'; plugin: string; text: string; timeoutMs: number }
  /** A dim transcript line ("● <mod>: text"). The model never reads it. */
  | { kind: 'log'; plugin: string; text: string }
  /** A highlighted heads-up in the transcript ("💡 <mod>: text"). The model never reads it. */
  | { kind: 'notice'; plugin: string; text: string }
  /** A hook failed or a mod did not load: "<mod>: tool.call hook skipped: threw …". */
  | { kind: 'error'; plugin: string; text: string }
  /** $.ui.open: a framed pane above the prompt; `id` is the ui.render requestId. */
  | { kind: 'pane.open'; plugin: string; id: string; title: string; rows?: number }
  /** $.ui.close, or the owning mod unloaded. */
  | { kind: 'pane.close'; plugin: string; id: string }
  /** Run the ui.render hooks again (renderSite). `plugin` absent = every mod changed. */
  | { kind: 'invalidate'; plugin?: string }
  /**
   * $.prompt.submit: start a turn with `text` once the session is idle. `text` already
   * carries the "[from mod <name>]" line unless asUser; send it through prompt.submit
   * (source 'mod') like any prompt.
   */
  | { kind: 'prompt'; plugin: string; text: string; asUser: boolean };

export type ModUiListener = (ev: ModUiEvent) => void;

interface Subscriber {
  fn: ModUiListener;
  /** This surface can draw panes ($.ui.open answers isPlaced: true). */
  panes: boolean;
}

const subscribers = new Set<Subscriber>();
const backlog: ModUiEvent[] = [];
const BACKLOG_MAX = 200;
const statusLines = new Map<string, string>();
const panes = new Map<string, { plugin: string; id: string; title: string; rows?: number }>();

let invalidatePending: { plugin?: string; all: boolean } | null = null;
let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
let lastInvalidateAt = 0;

function deliver(ev: ModUiEvent): void {
  if (subscribers.size === 0) {
    if (ev.kind === 'invalidate') return;
    backlog.push(ev);
    if (backlog.length > BACKLOG_MAX) backlog.shift();
    return;
  }
  for (const s of [...subscribers]) {
    try { s.fn(ev); } catch { /* a broken listener must not break the others or the mod */ }
  }
}

function flushInvalidate(): void {
  invalidateTimer = null;
  const p = invalidatePending;
  invalidatePending = null;
  if (!p) return;
  lastInvalidateAt = Date.now();
  deliver(p.all ? { kind: 'invalidate' } : { kind: 'invalidate', plugin: p.plugin });
}

/**
 * Subscribe a surface. `panes: true` when it draws panes (the TUI). Returns the
 * unsubscribe function. The first subscriber receives the backlog synchronously.
 */
export function subscribeModUi(listener: ModUiListener, opts: { panes?: boolean } = {}): () => void {
  const sub: Subscriber = { fn: listener, panes: opts.panes === true };
  const first = subscribers.size === 0;
  subscribers.add(sub);
  if (first && backlog.length) {
    const replay = backlog.splice(0, backlog.length);
    for (const ev of replay) {
      try { listener(ev); } catch { /* keep going */ }
    }
  }
  return () => { subscribers.delete(sub); };
}

/** Publish one event. Status and pane state are tracked here for late subscribers. */
export function emitModUi(ev: ModUiEvent): void {
  switch (ev.kind) {
    case 'status':
      if (ev.text === null || ev.text === '') statusLines.delete(ev.plugin);
      else statusLines.set(ev.plugin, ev.text);
      break;
    case 'pane.open':
      panes.set(ev.id, { plugin: ev.plugin, id: ev.id, title: ev.title, ...(ev.rows ? { rows: ev.rows } : {}) });
      break;
    case 'pane.close':
      panes.delete(ev.id);
      break;
    case 'invalidate': {
      // Coalesce: at most redrawPerSecond deliveries a second, trailing edge kept.
      const all = !ev.plugin || (invalidatePending !== null && (invalidatePending.all || invalidatePending.plugin !== ev.plugin));
      invalidatePending = { plugin: ev.plugin, all };
      if (invalidateTimer) return;
      const gap = Math.floor(1000 / MOD_LIMITS.redrawPerSecond);
      const wait = Math.max(0, lastInvalidateAt + gap - Date.now());
      invalidateTimer = setTimeout(flushInvalidate, wait);
      (invalidateTimer as { unref?: () => void }).unref?.();
      return;
    }
  }
  deliver(ev);
}

/** Current status line of each mod, in mod-name order. */
export function modStatusLines(): Array<{ plugin: string; text: string }> {
  return [...statusLines.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([plugin, text]) => ({ plugin, text }));
}

/** Panes open now, in the order they were opened. */
export function modOpenPanes(): Array<{ plugin: string; id: string; title: string; rows?: number }> {
  return [...panes.values()];
}

/** Which mod owns pane `id` (undefined when it is not open). */
export function modPaneOwner(id: string): string | undefined {
  return panes.get(id)?.plugin;
}

/** True when a subscribed surface draws panes. */
export function modUiHasPaneHost(): boolean {
  for (const s of subscribers) if (s.panes) return true;
  return false;
}

/** Drop everything a mod put on screen (it unloaded): its status line and its panes. */
export function clearModUi(plugin: string): void {
  if (statusLines.has(plugin)) emitModUi({ kind: 'status', plugin, text: null });
  for (const p of [...panes.values()]) {
    if (p.plugin === plugin) emitModUi({ kind: 'pane.close', plugin, id: p.id });
  }
  emitModUi({ kind: 'invalidate', plugin });
}

/** Tests: forget subscribers, backlog and state. */
export function resetModUiForTesting(): void {
  subscribers.clear();
  backlog.length = 0;
  statusLines.clear();
  panes.clear();
  if (invalidateTimer) clearTimeout(invalidateTimer);
  invalidateTimer = null;
  invalidatePending = null;
  lastInvalidateAt = 0;
}

/** Short names for the bus (the UI owner's contract): subscribe(listener, opts) / emit(event). */
export const subscribe = subscribeModUi;
export const emit = emitModUi;
