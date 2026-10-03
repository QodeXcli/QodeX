/**
 * The seam between the mods runtime (src/mods/*) and the terminal UI (src/mods/ui/*).
 *
 * The TUI never imports the engine. It talks to whatever object the runtime registers
 * with setModsUiHost(): a UI bus it can subscribe to (status lines, toasts, log and
 * notice lines, panes opening and closing, redraw requests), a way to run the
 * `ui.render` chain for one render site, a way to report a Button press, and the list
 * of mods. No host (mods off, headless, runtime not loaded yet) → the TUI draws nothing
 * extra and every mods surface stays empty.
 */

import type { ModElement, ModInfo, ModRenderSite, ModSurface } from '../types.js';

/** What the runtime's $.ui.* calls put on the bus. `plugin` is the calling mod's name. */
export type ModUiEvent =
  /** $.ui.status(text): one line under the prompt per mod; null clears it. */
  | { kind: 'status'; plugin: string; text: string | null }
  /** $.ui.toast(text, { timeoutMs }): a short notice at the top of the live area. */
  | { kind: 'toast'; plugin: string; text: string; timeoutMs?: number }
  /** $.ui.log(text): a dim history line ("● <mod>: …"). The model never reads it. */
  | { kind: 'log'; plugin: string; text: string }
  /** $.ui.notice(text): a highlighted history line ("💡 <mod>: …"). The model never reads it. */
  | { kind: 'notice'; plugin: string; text: string }
  /** $.ui.open(...): a framed pane above the prompt. `focus` / `closeOnEscape` are optional extras. */
  | { kind: 'open'; plugin: string; id: string; title?: string; rows?: number; focus?: boolean; closeOnEscape?: boolean }
  /** $.ui.close({ id }). */
  | { kind: 'close'; plugin: string; id: string }
  /** $.ui.invalidate(): run the ui.render hooks again (the TUI throttles to 10/s). No plugin = everything. */
  | { kind: 'invalidate'; plugin?: string }
  /** A mod was unloaded, disabled or is reloading: drop its status line, panes and refusal memory. */
  | { kind: 'unload'; plugin: string }
  /** Aliases of open / close (the names the runtime's bus uses); handled the same way. */
  | { kind: 'pane.open'; plugin: string; id: string; title?: string; rows?: number; focus?: boolean; closeOnEscape?: boolean }
  | { kind: 'pane.close'; plugin: string; id: string }
  /** A hook failed or a mod did not load: a red history line. The model never reads it. */
  | { kind: 'error'; plugin: string; text: string }
  /**
   * $.prompt.submit: the TUI queues `text` as the next prompt (it runs once the session is
   * idle). The runtime has already added the "[from mod <name>]" line unless asUser.
   */
  | { kind: 'prompt'; plugin: string; text: string; asUser?: boolean };

/** One `ui.render` request for a site, as the TUI asks for it. */
export interface ModRenderRequest {
  component: ModRenderSite;
  /** Pane: the id the pane was opened with. */
  requestId?: string;
  surface: ModSurface;
  props: Record<string, unknown>;
  viewport?: { columns: number; rows: number };
}

/**
 * What a site's `ui.render` chain produced.
 *
 * - AbovePrompt: every mod's hooks run as that mod's own chain, and each tree that comes
 *   back is listed here in load order (the band stacks them). Mods that drew nothing are
 *   left out.
 * - Pane: the tree for that pane (normally from the mod that opened it).
 * - Spinner: the chain's single result. When the chain reached QodeX's own drawing
 *   (`next(e)` all the way), `engineProps` holds the props it arrived with, so a
 *   `next({ ...e, props: { ...e.props, suffix } })` shows up as `engineProps.suffix`.
 *
 * Trees are NOT validated by the host; the TUI validates every tree before drawing.
 */
export interface ModRenderOutput {
  trees: Array<{ plugin: string; tree: ModElement }>;
  engineProps?: Record<string, unknown>;
}

/** What the TUI needs from the mods runtime. */
export interface ModsUiHost {
  /** Listen to the UI bus. Returns the unsubscribe function. */
  subscribe(listener: (ev: ModUiEvent) => void): () => void;
  /** Run the `ui.render` hooks for one site. Must not reject (resolve `{ trees: [] }` on failure). */
  renderSite(req: ModRenderRequest): Promise<ModRenderOutput>;
  /**
   * A Button the mod drew was pressed (hotkey or Enter): fire `ui.press` through the chain,
   * then run the button's onPress under the hook time limit. Must not reject.
   */
  press(req: { plugin: string; key: string; requestId?: string; component: ModRenderSite }, onPress?: () => void | Promise<void>): Promise<void>;
  /** The loaded and known mods (for hints and /mod new). */
  list(): ModInfo[];
  /** Optional: the user closed a pane from the keyboard (Ctrl+X X, or Esc on a closeOnEscape pane). */
  paneClosed?(req: { plugin: string; id: string }): void;
}

let current: ModsUiHost | null = null;
const watchers = new Set<(host: ModsUiHost | null) => void>();

/** Called by the runtime once its engine is up (and with null when it shuts down). */
export function setModsUiHost(host: ModsUiHost | null): void {
  current = host;
  for (const w of [...watchers]) {
    try { w(host); } catch { /* a broken watcher must not break the runtime */ }
  }
}

export function getModsUiHost(): ModsUiHost | null {
  return current;
}

/** Follow host changes (the TUI mounts before or after the runtime registers). Returns unsubscribe. */
export function onModsUiHostChange(watcher: (host: ModsUiHost | null) => void): () => void {
  watchers.add(watcher);
  return () => { watchers.delete(watcher); };
}
