/**
 * The resident is the process you leave up. It does not call a model.
 * Each pass fires due schedules, drains runnable desks, and (when asked)
 * seals witnessed skills. Bots, if configured, stay attached for the life
 * of the process — they are not restarted every pass.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { tick, type TickResult } from '../schedule/runner.js';
import { drainDesks, defaultSpawnDesk, type DeskJob } from './desks.js';
import { residentStatusPath } from './paths.js';
import { sealCandidates, type SealResult } from './seal.js';

export interface ResidentStatus {
  pid: number;
  startedAt: string;
  passAt: string;
  alive: boolean;
  schedule: { acquired: boolean; ran: number; failed: number };
  desks: { name: string; code: number }[];
  seal: { enabled: boolean; promoted: string[]; skipped: number; rejected: number };
  bots: string[];
  notes: string[];
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writeResidentStatus(status: ResidentStatus): Promise<void> {
  const file = residentStatusPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(status, null, 2));
  await fs.rename(tmp, file);
}

export async function readResidentStatus(): Promise<(ResidentStatus & { running: boolean }) | null> {
  try {
    const raw = JSON.parse(await fs.readFile(residentStatusPath(), 'utf-8')) as ResidentStatus;
    return { ...raw, running: pidAlive(raw.pid) };
  } catch {
    return null;
  }
}

export interface PassInput {
  cwd: string;
  seal: boolean;
  spawnDesk?: (name: string) => Promise<number>;
  tickFn?: () => Promise<TickResult>;
  sealFn?: (cwd: string) => Promise<SealResult>;
  loadJobs?: () => Promise<DeskJob[]>;
  startedAt?: string;
  bots?: string[];
  notes?: string[];
}

export async function residentPass(input: PassInput): Promise<ResidentStatus> {
  const [schedule, desks] = await Promise.all([
    (input.tickFn ?? tick)(),
    drainDesks(input.spawnDesk ?? (name => defaultSpawnDesk(name)), input.loadJobs),
  ]);
  let seal: ResidentStatus['seal'] = { enabled: false, promoted: [], skipped: 0, rejected: 0 };
  if (input.seal) {
    const sealed = await (input.sealFn ?? sealCandidates)(input.cwd);
    seal = {
      enabled: true,
      promoted: sealed.promoted,
      skipped: sealed.skipped.length,
      rejected: sealed.rejected.length,
    };
  }
  return {
    pid: process.pid,
    startedAt: input.startedAt ?? new Date().toISOString(),
    passAt: new Date().toISOString(),
    alive: true,
    schedule: { acquired: schedule.acquired, ran: schedule.ranIds.length, failed: schedule.failed.length },
    desks,
    seal,
    bots: input.bots ?? [],
    notes: input.notes ?? [],
  };
}

function sleep(ms: number, stopped: () => boolean): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    const poll = setInterval(() => {
      if (stopped()) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 200);
    const done = () => { clearInterval(poll); };
    timer.unref?.();
    setTimeout(done, ms).unref?.();
  });
}

export async function learningWantsSeal(cwd: string): Promise<boolean> {
  const { loadConfig } = await import('../config/loader.js');
  const cfg = await loadConfig(cwd);
  return (cfg as any).learning?.enabled === true;
}

export interface RunResidentOptions {
  cwd: string;
  once?: boolean;
  intervalMs?: number;
  /** true forces a seal, false skips, 'auto' follows learning.enabled. */
  seal?: boolean | 'auto';
  bots?: string[];
  notes?: string[];
  spawnDesk?: (name: string) => Promise<number>;
  tickFn?: () => Promise<TickResult>;
  sealFn?: (cwd: string) => Promise<SealResult>;
  stopGateway?: () => Promise<void>;
}

export async function runResident(opts: RunResidentOptions): Promise<ResidentStatus> {
  const startedAt = new Date().toISOString();
  const intervalMs = Math.max(15_000, opts.intervalMs ?? 60_000);
  let stop = false;
  const onStop = () => { stop = true; };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);

  let last: ResidentStatus | null = null;
  try {
    do {
      const seal = opts.seal === true
        ? true
        : opts.seal === false
          ? false
          : await learningWantsSeal(opts.cwd);
      last = await residentPass({
        cwd: opts.cwd,
        seal,
        spawnDesk: opts.spawnDesk,
        tickFn: opts.tickFn,
        sealFn: opts.sealFn,
        startedAt,
        bots: opts.bots,
        notes: opts.notes,
      });
      await writeResidentStatus(last);
      if (opts.once || stop) break;
      await sleep(intervalMs, () => stop);
    } while (!stop);
  } finally {
    process.off('SIGINT', onStop);
    process.off('SIGTERM', onStop);
    if (opts.stopGateway) await opts.stopGateway().catch(() => {});
  }
  return last!;
}
