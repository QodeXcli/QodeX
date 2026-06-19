/**
 * Platform installer for the scheduler "tick" — a process that fires every minute
 * and runs `qodex schedule tick`. macOS gets a LaunchAgent plist; Linux gets a
 * crontab line printed to stdout for the user to install.
 *
 * On macOS we write `~/Library/LaunchAgents/com.qodex.scheduler.plist` and load
 * it with `launchctl load -w`. Subsequent runs of `qodex schedule install` are
 * idempotent (load -w re-loads cleanly if already loaded).
 *
 * On Linux we print the crontab line so the user can decide where to put it —
 * we don't want to silently mutate ~/.crontab on someone's server.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { QODEX_HOME } from '../config/defaults.js';

const PLIST_LABEL = 'com.qodex.scheduler';
const PLIST_PATH = path.join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

export interface InstallResult {
  installed: boolean;
  platform: NodeJS.Platform;
  message: string;
  artifactPath?: string;
}

export async function install(): Promise<InstallResult> {
  await fs.mkdir(QODEX_HOME, { recursive: true });

  if (process.platform === 'darwin') {
    return installLaunchd();
  }
  if (process.platform === 'linux') {
    return printCrontab();
  }
  return {
    installed: false,
    platform: process.platform,
    message: `Auto-install is not supported on ${process.platform}. Manually invoke \`qodex schedule tick\` from your platform's scheduler (Task Scheduler on Windows, cron on Unix).`,
  };
}

export async function uninstall(): Promise<InstallResult> {
  if (process.platform === 'darwin') {
    // unload then remove
    spawnSync('launchctl', ['unload', '-w', PLIST_PATH], { stdio: 'ignore' });
    try { await fs.unlink(PLIST_PATH); } catch {}
    return { installed: false, platform: 'darwin', message: 'Uninstalled LaunchAgent.', artifactPath: PLIST_PATH };
  }
  return { installed: false, platform: process.platform, message: 'Nothing to uninstall on this platform — remove the crontab line manually.' };
}

async function installLaunchd(): Promise<InstallResult> {
  const launchAgents = path.dirname(PLIST_PATH);
  await fs.mkdir(launchAgents, { recursive: true });

  // Resolve the qodex bin: prefer `qodex` on PATH (works post `npm link`).
  const which = spawnSync('which', ['qodex'], { encoding: 'utf-8' });
  const qodexPath = (which.stdout || '').trim() || '/usr/local/bin/qodex';

  const logPath = path.join(QODEX_HOME, 'scheduler.out.log');
  const errPath = path.join(QODEX_HOME, 'scheduler.err.log');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(qodexPath)}</string>
    <string>schedule</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>QODEX_SCHEDULED</key>
    <string>1</string>
  </dict>
</dict>
</plist>
`;

  await fs.writeFile(PLIST_PATH, plist);
  // Reload — unload first to handle the "already loaded" case cleanly.
  spawnSync('launchctl', ['unload', PLIST_PATH], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['load', '-w', PLIST_PATH], { encoding: 'utf-8' });
  if (r.status !== 0) {
    return {
      installed: false,
      platform: 'darwin',
      message: `Wrote plist but launchctl load failed: ${r.stderr || r.stdout}`,
      artifactPath: PLIST_PATH,
    };
  }
  return {
    installed: true,
    platform: 'darwin',
    message: `LaunchAgent installed. Ticks every 60s. Logs: ${logPath}`,
    artifactPath: PLIST_PATH,
  };
}

function printCrontab(): InstallResult {
  const which = spawnSync('which', ['qodex'], { encoding: 'utf-8' });
  const qodexPath = (which.stdout || '').trim() || 'qodex';
  const line = `* * * * * ${qodexPath} schedule tick >> ${path.join(QODEX_HOME, 'scheduler.out.log')} 2>> ${path.join(QODEX_HOME, 'scheduler.err.log')}`;
  return {
    installed: false,
    platform: 'linux',
    message: `Add this line to your crontab (\`crontab -e\`):\n\n${line}\n`,
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
