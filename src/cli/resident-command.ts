/**
 * `qodex up` — one local process for schedules, desks, witnessed seals, and
 * bots you already configured. It does not call a model of its own.
 */
import { Command } from 'commander';
import { learningWantsSeal, readResidentStatus, runResident } from '../resident/loop.js';
import { residentChildArgs, spawnResident } from '../resident/detach.js';
import { residentLogPath } from '../resident/paths.js';
import { writeService, servicePlatform } from '../resident/service.js';

function formatStatus(s: Awaited<ReturnType<typeof readResidentStatus>>): string {
  if (!s) return 'Resident is not running. Start it with `qodex up`.';
  const state = s.running ? 'running' : 'stale (pid is gone)';
  const lines = [
    `resident ${state} · pid ${s.pid}`,
    `started ${s.startedAt}`,
    `last pass ${s.passAt}`,
    `schedule acquired=${s.schedule.acquired} ran=${s.schedule.ran} failed=${s.schedule.failed}`,
    `desks ${s.desks.length ? s.desks.map(d => `${d.name}:${d.code}`).join(', ') : 'none'}`,
    `seal ${s.seal.enabled ? `promoted=${s.seal.promoted.join(',') || 'none'} skipped=${s.seal.skipped} rejected=${s.seal.rejected}` : 'off'}`,
    `bots ${s.bots.length ? s.bots.join(', ') : 'none'}`,
  ];
  for (const n of s.notes) lines.push(`note: ${n}`);
  return lines.join('\n');
}

export function buildResidentCommand(deps: {
  bootstrap: () => Promise<{ config: any; router: any; registry: any; permissions: any }>;
}): Command {
  const cmd = new Command('up');
  cmd.description('Leave one process up: schedules, desks, witnessed skill seals, and configured bots');
  cmd.option('--once', 'Run a single pass and exit. Does not open bots.');
  cmd.option('--interval <seconds>', 'Seconds between passes (minimum 15)', '60');
  cmd.option('--seal', 'Seal witnessed candidates even when learning.enabled is off');
  cmd.option('--skip-seal', 'Do not seal candidates');
  cmd.option('--no-bots', 'Do not attach chat platforms');
  cmd.option('--detach', 'Start in the background. Closing the terminal does not stop it.');

  cmd
    .command('status')
    .description('Show the last resident pass, and whether that pid is still alive')
    .action(async () => {
      console.log(formatStatus(await readResidentStatus()));
    });

  cmd
    .command('stop')
    .description('Stop the detached resident, if its pid is still alive')
    .action(async () => {
      const s = await readResidentStatus();
      if (!s?.running) {
        console.log(s ? 'resident pid is already gone' : 'Resident is not running.');
        return;
      }
      try {
        process.kill(s.pid, 'SIGTERM');
        console.log(`signaled ${s.pid}`);
      } catch (e: any) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    });

  cmd
    .command('install')
    .description('Write a user service that starts `qodex up` after reboot. systemd or launchd. Not a cloud.')
    .action(async () => {
      const platform = servicePlatform();
      const home = process.env.HOME || process.env.USERPROFILE;
      const exec = process.argv[1];
      if (!home || !exec) {
        console.error('cannot see HOME or the qodex script path');
        process.exitCode = 1;
        return;
      }
      try {
        const file = await writeService(platform, home, exec);
        console.log(`wrote ${file}`);
        console.log('This starts the resident after reboot of a machine that stays on.');
        console.log('It does not keep running while a laptop is asleep, and it is not hosted anywhere.');
        if (platform === 'linux') console.log('enable: systemctl --user enable --now qodex-resident.service');
        if (platform === 'darwin') console.log('enable: launchctl load ~/Library/LaunchAgents/com.qodex.resident.plist');
      } catch (e: any) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
    });

  cmd.action(async (opts: { once?: boolean; interval?: string; seal?: boolean; skipSeal?: boolean; bots?: boolean; detach?: boolean }) => {
    if (opts.detach) {
      const existing = await readResidentStatus();
      if (existing?.running) {
        console.log(formatStatus(existing));
        return;
      }
      const args = residentChildArgs(['up']);
      if (opts.interval && opts.interval !== '60') args.push('--interval', String(opts.interval));
      if (opts.seal) args.push('--seal');
      if (opts.skipSeal) args.push('--skip-seal');
      if (opts.bots === false) args.push('--no-bots');
      try {
        const pid = spawnResident({ args, logPath: residentLogPath() });
        console.log(`resident detached · pid ${pid}`);
        console.log(`log ${residentLogPath()}`);
        console.log('Closing this terminal does not stop it. `qodex up stop` does.');
        console.log('Chat reaches it only on a platform you already enabled, with a token and an allowlist.');
      } catch (e: any) {
        console.error(e?.message ?? e);
        process.exitCode = 1;
      }
      return;
    }
    const intervalMs = Math.max(15, Number(opts.interval) || 60) * 1000;
    const seal: boolean | 'auto' = opts.skipSeal ? false : opts.seal ? true : 'auto';
    const notes: string[] = [];
    let bots: string[] = [];
    let stopGateway: (() => Promise<void>) | undefined;

    if (!opts.once && opts.bots !== false) {
      try {
        const boot = await deps.bootstrap();
        const { openBots } = await import('../bot/start.js');
        const opened = await openBots({
          config: boot.config,
          router: boot.router,
          registry: boot.registry,
          permissions: boot.permissions,
          cwd: process.cwd(),
        });
        notes.push(...opened.notes);
        if (opened.gateway) {
          bots = opened.platforms;
          stopGateway = () => opened.gateway!.stop();
          console.error(`bots: ${bots.join(', ')}`);
        } else if (opened.notes.length === 0) {
          notes.push('no bot platform is enabled — resident continues without chat');
        }
      } catch (e: any) {
        notes.push(`bots did not start: ${e?.message ?? e}`);
      }
      for (const n of notes) console.error(n);
    }

    if (seal === 'auto') {
      const on = await learningWantsSeal(process.cwd());
      console.error(on
        ? 'seal: on (learning.enabled)'
        : 'seal: off (learning.enabled is not true; pass --seal to close the loop anyway)');
    }

    console.error(opts.once ? 'resident pass' : `resident up · every ${intervalMs / 1000}s · Ctrl-C to stop`);
    const status = await runResident({
      cwd: process.cwd(),
      once: opts.once,
      intervalMs,
      seal,
      bots,
      notes,
      stopGateway,
    });
    console.log(formatStatus({ ...status, running: true }));
    if (!opts.once) process.exit(0);
  });

  return cmd;
}
