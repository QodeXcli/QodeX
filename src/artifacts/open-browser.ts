/**
 * Open a URL in the user's default browser — best-effort, cross-platform.
 *
 * The whole point of a LIVE artifact is that the user WATCHES the page while the
 * model iterates. Returning a URL as text isn't enough — most users won't copy a
 * localhost link out of a tool result. So when a live server starts we pop the
 * page open for them; the existing SSE hot-reload then keeps it in sync as the
 * model edits, so they literally see each change land.
 *
 * This is intentionally defensive: it NEVER throws and NEVER blocks. If there's no
 * display (headless box, CI, SSH without forwarding) or the opener command is
 * missing, it quietly reports `false` and the caller falls back to printing the URL.
 */
import spawn from 'cross-spawn';

/**
 * Should we even try to open a browser? False on the obvious non-interactive /
 * headless cases so a server run or CI job doesn't try to spawn a GUI.
 */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  // Explicit opt-out (any of the common spellings) always wins.
  if (env.QODEX_NO_BROWSER || env.QODEX_NO_OPEN || env.NO_BROWSER) return false;
  // CI systems have no human at a screen.
  if (env.CI) return false;
  // On Linux/BSD a GUI needs an X11 or Wayland display; without one, opening fails.
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  }
  return true;
}

/** The platform-appropriate opener command + args for a URL. */
function openerFor(url: string, platform: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  // linux / *bsd and the rest
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Try to open `url` in the default browser. Resolves `true` if the opener was
 * launched (we don't wait for the browser itself), `false` if skipped or it failed
 * to spawn. Detached + unref'd so it never keeps the QodeX process alive.
 */
export async function openUrl(
  url: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: string } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (!canOpenBrowser(env, platform)) return false;
  const { cmd, args } = openerFor(url, platform);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    let ok = true;
    child.on('error', () => { ok = false; }); // ENOENT (opener missing) etc. — swallow
    child.unref();
    // Give a spawn error a tick to surface before we report success.
    await new Promise(r => setTimeout(r, 0));
    return ok;
  } catch {
    return false;
  }
}
