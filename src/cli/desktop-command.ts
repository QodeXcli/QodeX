/**
 * `qodex desktop` — open the local shell. Loopback only. No model, no cloud browser.
 * The native binary is an OS window. Chrome --app is not called native.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { startDesktopShell } from '../desktop/shell.js';
import { appWindowLaunch, findAppBrowser, nativeWindowLaunch } from '../desktop/window.js';
import { canOpenBrowser, openUrl } from '../artifacts/open-browser.js';

function nativePaths(): { binary: string | null; manifest: string | null } {
  if (process.env.QODEX_NATIVE_DESKTOP && existsSync(process.env.QODEX_NATIVE_DESKTOP)) {
    return { binary: process.env.QODEX_NATIVE_DESKTOP, manifest: null };
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const name = process.platform === 'win32' ? 'qodex-desktop.exe' : 'qodex-desktop';
  const roots = [path.resolve(here, '../..'), path.resolve(here, '../../..')];
  const binary = roots.map(root => path.join(root, 'native', 'target', 'release', name))
    .concat(roots.map(root => path.join(root, 'native', 'target', 'debug', name)))
    .find(file => existsSync(file)) ?? null;
  const manifest = roots.map(root => path.join(root, 'native', 'Cargo.toml')).find(file => existsSync(file)) ?? null;
  return { binary, manifest };
}

export function buildDesktopCommand(): Command {
  const cmd = new Command('desktop');
  cmd
    .description('Open the local operator window: desks, goals, run next, sentinel, named controls, screenshot. 127.0.0.1 only.')
    .option('--port <n>', 'Port', '0')
    .option('--no-open', 'Do not open a window; print the URL')
    .option('--native', 'Require the OS window. Do not fall back to a browser.')
    .option('--build-native', 'Compile the OS window with cargo, then open it')
    .action(async (opts: { port?: string; open?: boolean; native?: boolean; buildNative?: boolean }) => {
      let located = nativePaths();
      if (opts.buildNative) {
        if (!located.manifest) {
          console.error('native/Cargo.toml was not found. This install has no native source.');
          if (opts.native) process.exit(1);
        } else {
          console.log(`Building the native window (${located.manifest})…`);
          const built = spawnSync('cargo', ['build', '--release', '--manifest-path', located.manifest], { stdio: 'inherit' });
          if (built.status !== 0) {
            console.error(built.error ? `cargo failed: ${built.error.message}` : 'cargo build failed. The native window was not created.');
            if (opts.native) process.exit(built.status || 1);
          }
          located = nativePaths();
        }
      }
      const handle = await startDesktopShell(Number(opts.port) || 0);
      console.log(`\nQodeX Desktop → ${handle.url}`);
      console.log('   Loopback only. Ctrl-C stops it. A press on this page is you, not the model.\n');
      if (opts.open !== false) {
        const native = nativeWindowLaunch(handle.url, located.binary);
        if (native) {
          const child = spawn(native.cmd, native.args, { stdio: 'ignore', detached: true });
          child.on('error', err => console.error(`Native window failed to start: ${err.message}`));
          child.unref();
          console.log('   Native window. This is an OS window, not a browser tab.');
        } else if (opts.native) {
          console.error('   No native binary. Build one with: qodex desktop --build-native');
          await handle.close();
          process.exit(1);
        } else if (canOpenBrowser()) {
          const browser = findAppBrowser();
          const launch = appWindowLaunch(process.platform, handle.url, browser);
          if (launch) {
            const child = spawn(launch.cmd, launch.args, { stdio: 'ignore', detached: true });
            child.on('error', () => { /* the next line already says what opened */ });
            child.unref();
            console.log(`   App window: ${launch.cmd}. This is Chrome --app, not the native window.`);
          } else {
            const opened = await openUrl(handle.url);
            console.log(opened
              ? '   No native binary and no Chrome/Chromium/Edge app window. Opened in the default browser. This is a tab.'
              : '   Could not open a window. Use the URL above.');
          }
        } else {
          console.log('   No native binary and no browser here. Use the URL above, or build the OS window with: qodex desktop --build-native');
        }
      }
      const shutdown = () => { void handle.close().then(() => process.exit(0)); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise<never>(() => {});
    });
  return cmd;
}