/**
 * Open the shell as an application window, not a browser tab.
 * Chrome / Chromium / Edge --app= hides the browser chrome. If none of
 * those exist, the caller falls back to the default browser and says so.
 * The URL must be loopback. This function does not launch anything.
 */
import { spawnSync } from 'child_process';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+\//;

export function isLoopbackAppUrl(url: string): boolean {
  return LOOPBACK.test(url);
}

export function findAppBrowser(pathEnv = process.env.PATH ?? '', platform = process.platform): string | null {
  const names = platform === 'darwin'
    ? ['Google Chrome', 'Chromium', 'Microsoft Edge']
    : platform === 'win32'
      ? ['chrome', 'msedge']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  if (platform === 'darwin') {
    for (const name of names) {
      const app = `/Applications/${name}.app`;
      const hit = spawnSync('test', ['-d', app], { encoding: 'utf8' });
      if (hit.status === 0) return name;
    }
    return null;
  }
  for (const name of names) {
    const hit = spawnSync('which', [name], { encoding: 'utf8', env: { ...process.env, PATH: pathEnv } });
    if (hit.status === 0 && hit.stdout.trim()) return hit.stdout.trim();
  }
  return null;
}

/** Args for an app window. Null if the URL is not loopback or no browser was found. */
export function appWindowLaunch(platform: string, url: string, browser: string | null): { cmd: string; args: string[] } | null {
  if (!browser || !isLoopbackAppUrl(url)) return null;
  if (platform === 'darwin') {
    return { cmd: 'open', args: ['-na', browser, '--args', `--app=${url}`] };
  }
  return { cmd: browser, args: [`--app=${url}`, '--new-window'] };
}

/** A real OS window. Null unless the binary exists and the URL is loopback. */
export function nativeWindowLaunch(url: string, binary: string | null): { cmd: string; args: string[] } | null {
  if (!binary || !isLoopbackAppUrl(url)) return null;
  return { cmd: binary, args: ['--url', url] };
}
