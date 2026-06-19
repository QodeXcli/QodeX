/**
 * Native desktop notification — used to tell the user a long-running background
 * task (a scheduled/autonomous run) finished, so they can close the terminal and
 * get pulled back only when it matters.
 *
 * macOS only, by design: uses the built-in `osascript -e 'display notification'`,
 * so there's NO new dependency and nothing to install. On any other platform, or
 * if osascript isn't present, this is a silent no-op — it never throws and never
 * blocks the caller (fire-and-forget). A notification failing must never break a
 * task that otherwise succeeded.
 */
import { spawn } from 'cross-spawn';
import { logger } from './logger.js';

export interface DesktopNotification {
  title: string;
  /** The bold line under the title. */
  subtitle?: string;
  /** Body text. */
  message: string;
  /** Play the default notification sound. */
  sound?: boolean;
}

/**
 * AppleScript string literals are double-quoted; the only characters we must
 * neutralize are double-quote and backslash. Newlines are allowed inside the
 * literal but we collapse them so the notification stays one tidy line.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Show a desktop notification. Fire-and-forget: returns immediately, resolves
 * when the (very fast) osascript call finishes. Never rejects.
 */
export async function notifyDesktop(n: DesktopNotification): Promise<void> {
  if (process.platform !== 'darwin') return; // macOS only

  // Build: display notification "msg" with title "t" subtitle "s" sound name "Glass"
  let script = `display notification "${escapeAppleScript(n.message)}" with title "${escapeAppleScript(n.title)}"`;
  if (n.subtitle) script += ` subtitle "${escapeAppleScript(n.subtitle)}"`;
  if (n.sound) script += ` sound name "Glass"`;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
      child.on('error', (e: any) => {
        logger.debug?.('desktop notification unavailable', { err: e?.message });
        finish();
      });
      child.on('close', () => finish());
      // Safety: never hang the caller on a stuck osascript.
      setTimeout(() => { try { child.kill(); } catch {} finish(); }, 5000);
    } catch (e: any) {
      logger.debug?.('desktop notification failed to spawn', { err: e?.message });
      finish();
    }
  });
}
