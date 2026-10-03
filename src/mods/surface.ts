/**
 * Mods for the two surfaces: the interactive TUI (index.ts) and `qodex -p` (headless.ts).
 * Each function is a no-op when QODEX_NO_MODS=1 (the escape hatch for a mod that breaks
 * startup) and never throws: a mods failure is logged and QodeX goes on without them.
 */
import { logger } from '../utils/logger.js';
import { initMods, getModsRuntime, modsActive, type ModsBindings } from './runtime.js';
import { modsPromptSubmit, withModContext } from './integration.js';

let sessionStartedFor: string | null = null;
let markReady: () => void = () => {};
let ready: Promise<void> = new Promise<void>(r => { markReady = r; });

/**
 * Resolves once session.start finished for the TUI session (at most 15 s; at once when
 * mods are off). The TUI awaits it before sending the first prompt through prompt.submit.
 */
export function modsSessionReady(): Promise<void> {
  if (!getModsRuntime()) return Promise.resolve();
  return Promise.race([ready, new Promise<void>(r => { const t = setTimeout(r, 15_000); (t as { unref?: () => void }).unref?.(); })]);
}

export function modsDisabledByEnv(): boolean {
  return process.env.QODEX_NO_MODS === '1';
}

/** TUI: load mods (watching user / --mod-dir mods for changes). Call before rendering. */
export async function modsInteractiveInit(opts: { cwd: string; bindings: ModsBindings; extraDirs?: string[] }): Promise<void> {
  if (modsDisabledByEnv()) return;
  try {
    await initMods({ cwd: opts.cwd, surface: 'terminal', bindings: opts.bindings, extraDirs: opts.extraDirs, watch: true });
  } catch (e: any) {
    logger.warn('Mods did not start', { err: e?.message });
  }
}

/**
 * The TUI's session id became known (startup) or changed (/clear, /resume): session.start
 * fires once, before the first prompt; a later id only re-points the mods.
 */
export async function modsSessionActive(sessionId: string, cwd?: string): Promise<void> {
  const rt = getModsRuntime();
  if (!rt) { markReady(); return; }
  try {
    if (sessionStartedFor === null) {
      sessionStartedFor = sessionId;
      await rt.startSession(sessionId, cwd);
      markReady();
    } else if (sessionStartedFor !== sessionId) {
      sessionStartedFor = sessionId;
      rt.setSession(sessionId, cwd);
    }
  } catch (e: any) {
    logger.warn('Mods session.start failed', { err: e?.message });
    markReady();
  }
}

/** session.end for every mod (1.5 s cap), then stop timers and watchers. */
export async function modsShutdown(reason: 'exit' | 'clear' | 'resume' | 'other' = 'exit'): Promise<void> {
  const rt = getModsRuntime();
  if (!rt) return;
  try {
    await rt.endSession(reason);
  } catch { /* capped and best-effort */ }
  if (reason === 'exit') rt.dispose();
}

/** /clear or /resume: session.end for every mod; the next session id gets no session.start. */
export async function modsSessionEnded(reason: 'clear' | 'resume'): Promise<void> {
  const rt = getModsRuntime();
  if (!rt || !modsActive()) return;
  try {
    await rt.endSession(reason);
    rt.setSession(rt.sessionId);
  } catch { /* capped and best-effort */ }
}

/**
 * Headless: load mods, session.start, then prompt.submit. Returns the prompt the model
 * reads (mod context appended) or `drop` with the reason a mod gave.
 */
export async function modsHeadlessBegin(
  opts: { cwd: string; sessionId: string; bindings: ModsBindings; extraDirs?: string[] },
  prompt: string,
): Promise<{ text: string; drop?: string }> {
  if (modsDisabledByEnv()) return { text: prompt };
  try {
    const rt = await initMods({ cwd: opts.cwd, surface: 'headless', bindings: opts.bindings, extraDirs: opts.extraDirs });
    if (!modsActive()) return { text: prompt };
    await rt.startSession(opts.sessionId, opts.cwd);
    sessionStartedFor = opts.sessionId;
    const sub = await modsPromptSubmit(prompt, 'user');
    if (sub.drop) return { text: prompt, drop: sub.drop };
    return { text: withModContext(sub.text, sub.context) };
  } catch (e: any) {
    logger.warn('Mods did not start (headless)', { err: e?.message });
    return { text: prompt };
  }
}

/** Headless: session.end when the run is over. */
export async function modsHeadlessEnd(): Promise<void> {
  if (!modsActive()) return;
  try {
    await getModsRuntime()?.endSession('exit'); // the process exits right after
  } catch { /* capped and best-effort */ }
}

/** Tests: forget which session started. */
export function resetModsSurfaceForTesting(): void {
  sessionStartedFor = null;
  ready = new Promise<void>(r => { markReady = r; });
}
