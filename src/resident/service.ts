/**
 * A user service so the resident comes back after reboot.
 * systemd and launchd only. A laptop that is asleep is still asleep.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

export type ServicePlatform = 'linux' | 'darwin' | 'unsupported';

export function servicePlatform(platform = process.platform): ServicePlatform {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'darwin';
  return 'unsupported';
}

function xml(s: string): string {
  return s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
}

export function systemdUnit(exec: string): string {
  const start = exec.includes(' ') ? JSON.stringify(exec) : exec;
  return `[Unit]
Description=QodeX resident
After=network-online.target

[Service]
Type=simple
ExecStart=${start} up
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(exec: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.qodex.resident</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(exec)}</string>
    <string>up</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

export function serviceFile(platform: ServicePlatform, home: string, exec: string): { path: string; body: string } | null {
  if (platform === 'linux') {
    return {
      path: path.join(home, '.config', 'systemd', 'user', 'qodex-resident.service'),
      body: systemdUnit(exec),
    };
  }
  if (platform === 'darwin') {
    return {
      path: path.join(home, 'Library', 'LaunchAgents', 'com.qodex.resident.plist'),
      body: launchdPlist(exec),
    };
  }
  return null;
}

export async function writeService(platform: ServicePlatform, home: string, exec: string): Promise<string> {
  const file = serviceFile(platform, home, exec);
  if (!file) throw new Error('install is systemd or launchd only. On Windows use `qodex up --detach`.');
  await fs.mkdir(path.dirname(file.path), { recursive: true });
  await fs.writeFile(file.path, file.body);
  return file.path;
}
