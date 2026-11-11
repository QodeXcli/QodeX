/**
 * Drain runnable desk goals from the resident. Different directories at once.
 * The same directory is sequential so two desks don't edit one checkout together.
 * The resident does not claim the goal itself — `qodex desk run` does, in a child,
 * so a hung agent dies with the child and the board lock is not held here.
 */
import { spawn } from 'cross-spawn';
import { peekRunnable } from '../desk/board.js';
import { loadBoard } from '../desk/store.js';

export interface DeskJob {
  name: string;
  cwd: string;
}

export function groupByCwd(jobs: DeskJob[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const job of jobs) {
    const list = groups.get(job.cwd) ?? [];
    list.push(job.name);
    groups.set(job.cwd, list);
  }
  return [...groups.values()];
}

export async function runnableDeskJobs(): Promise<DeskJob[]> {
  const board = await loadBoard();
  return board.desks
    .filter(d => peekRunnable(d))
    .map(d => ({ name: d.name, cwd: d.cwd }));
}

export function defaultSpawnDesk(name: string, timeoutSec = 600): Promise<number> {
  const script = process.argv[1];
  if (!script) return Promise.resolve(1);
  const seconds = String(Math.max(5, Math.round(timeoutSec)));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...process.execArgv, script, 'desk', 'run', name, '--sentinel-timeout', seconds], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', () => resolve(1));
    child.on('exit', code => resolve(code ?? 1));
  });
}

export async function drainDesks(
  spawnDesk: (name: string) => Promise<number>,
  load: () => Promise<DeskJob[]> = runnableDeskJobs,
): Promise<{ name: string; code: number }[]> {
  const groups = groupByCwd(await load());
  const out: { name: string; code: number }[] = [];
  await Promise.all(groups.map(async names => {
    for (const name of names) {
      out.push({ name, code: await spawnDesk(name) });
    }
  }));
  return out;
}
