/**
 * `qodex up` — one local process for schedules, desks, witnessed seals, and
 * bots you already configured. It does not call a model of its own.
 */
import { Command } from 'commander';
import { learningWantsSeal, readResidentStatus, runResident } from '../resident/loop.js';

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

  cmd
    .command('status')
    .description('Show the last resident pass, and whether that pid is still alive')
    .action(async () => {
      console.log(formatStatus(await readResidentStatus()));
    });

  cmd.action(async (opts: { once?: boolean; interval?: string; seal?: boolean; skipSeal?: boolean; bots?: boolean }) => {
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
