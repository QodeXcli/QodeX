/**
 * `qodex desktop` — open the local shell. Loopback only. No model, no cloud browser.
 */
import { spawn } from 'child_process';
import { Command } from 'commander';
import { startDesktopShell } from '../desktop/shell.js';
import { appWindowLaunch, findAppBrowser } from '../desktop/window.js';
import { canOpenBrowser, openUrl } from '../artifacts/open-browser.js';

export function buildDesktopCommand(): Command {
  const cmd = new Command('desktop');
  cmd
    .description('Open the local operator window: desks, goals, sentinel, named controls, screenshot. 127.0.0.1 only. Does not call a model.')
    .option('--port <n>', 'Port', '0')
    .option('--no-open', 'Do not open a window; print the URL')
    .action(async (opts: { port?: string; open?: boolean }) => {
      const handle = await startDesktopShell(Number(opts.port) || 0);
      console.log(`\nQodeX Desktop → ${handle.url}`);
      console.log('   Loopback only. Ctrl-C stops it. A press on this page is you, not the model.\n');
      if (opts.open !== false && canOpenBrowser()) {
        const browser = findAppBrowser();
        const launch = appWindowLaunch(process.platform, handle.url, browser);
        if (launch) {
          const child = spawn(launch.cmd, launch.args, { stdio: 'ignore', detached: true });
          child.on('error', () => { /* printed below if we also fall back */ });
          child.unref();
          console.log(`   App window: ${launch.cmd}`);
        } else {
          const opened = await openUrl(handle.url);
          console.log(opened
            ? '   No Chrome/Chromium/Edge app window found. Opened in the default browser instead. This is a tab, not a shell window.'
            : '   Could not open a window. Use the URL above.');
        }
      }
      const shutdown = () => { void handle.close().then(() => process.exit(0)); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise<never>(() => {});
    });
  return cmd;
}
