/**
 * The mods runtime's public surface for the rest of QodeX (the TUI above all). Import from
 * here rather than from the individual modules.
 *
 *   UI bus      subscribeModUi / emitModUi (alias subscribe / emit), modStatusLines,
 *               modOpenPanes — status, toast, log, notice, error, pane open/close,
 *               invalidate and prompt events from $.ui.* / $.prompt.submit.
 *   Drawing     renderSite(site, props, opts) → ModElement[] (one per mod that drew),
 *               renderSiteDetailed (with the mod names), renderSpinner (suffix / replacement),
 *               pressModButton (a drawn Button was pressed).
 *   Prompts     modsPromptSubmit + withModContext (prompt.submit), modsSessionReady.
 *   Commands    listModCommands, isImmediateModCommand.
 */
export {
  subscribeModUi, emitModUi, subscribe, emit, modStatusLines, modOpenPanes, modPaneOwner, modUiHasPaneHost,
  type ModUiEvent, type ModUiListener,
} from './ui-bus.js';
export {
  renderSite, renderSiteDetailed, renderSpinner, pressModButton, modsPromptSubmit, withModContext,
  type ModRenderOutput, type RenderOptions,
} from './integration.js';
export { modsSessionReady, modsSessionActive, modsShutdown } from './surface.js';
export { listModCommands, isImmediateModCommand, type ModCommand } from './command-registry.js';
export { getModsRuntime, modsActive } from './runtime.js';
export { findModElement, isModElement, modElementText, MOD_ELEMENTS } from './elements.js';
export type * from './types.js';
export { MOD_LIMITS } from './types.js';
