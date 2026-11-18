/**
 * Jobs live on the host. The client may disconnect. The file is the queue.
 */
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export type JobState = 'queued' | 'running' | 'done' | 'held' | 'error';

export interface HostJob {
  id: string;
  prompt: string;
  project: string;
  state: JobState;
  result?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
}

export class JobStore {
  private jobs: HostJob[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as HostJob[];
      this.jobs = Array.isArray(raw) ? raw : [];
    } catch {
      this.jobs = [];
    }
    for (const job of this.jobs) {
      if (job.state === 'running') job.state = 'queued';
    }
  }

  list(): HostJob[] {
    return this.jobs.map(j => ({ ...j }));
  }

  get(id: string): HostJob | null {
    const job = this.jobs.find(j => j.id === id);
    return job ? { ...job } : null;
  }

  async add(input: { prompt: string; project: string }): Promise<HostJob> {
    const job: HostJob = {
      id: randomBytes(8).toString('hex'),
      prompt: input.prompt,
      project: input.project,
      state: 'queued',
      createdAt: new Date().toISOString(),
    };
    await this.mutate(jobs => {
      jobs.push(job);
      const done = jobs.filter(j => j.state === 'done' || j.state === 'error' || j.state === 'held');
      while (jobs.length > 100 && done.length) {
        const drop = done.shift()!;
        const i = jobs.findIndex(j => j.id === drop.id);
        if (i >= 0) jobs.splice(i, 1);
      }
    });
    return { ...job };
  }

  async claim(): Promise<HostJob | null> {
    let claimed: HostJob | null = null;
    await this.mutate(jobs => {
      const next = jobs.find(j => j.state === 'queued');
      if (!next) return;
      next.state = 'running';
      claimed = { ...next };
    });
    return claimed;
  }

  async finish(id: string, patch: Pick<HostJob, 'state' | 'result' | 'error'>): Promise<void> {
    await this.mutate(jobs => {
      const job = jobs.find(j => j.id === id);
      if (!job) return;
      job.state = patch.state;
      job.result = patch.result;
      job.error = patch.error;
      job.finishedAt = new Date().toISOString();
    });
  }

  private async mutate(fn: (jobs: HostJob[]) => void): Promise<void> {
    const run = this.chain.then(async () => {
      fn(this.jobs);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(this.jobs));
      await fs.rename(tmp, this.file);
    });
    this.chain = run.catch(() => {});
    await run;
  }
}

export async function drainOne(store: JobStore, run: (job: HostJob) => Promise<{ state: 'done' | 'held'; text: string }>): Promise<HostJob | null> {
  const job = await store.claim();
  if (!job) return null;
  try {
    const out = await run(job);
    await store.finish(job.id, { state: out.state, result: out.text });
  } catch (e: any) {
    await store.finish(job.id, { state: 'error', error: e?.message ?? String(e) });
  }
  return store.get(job.id);
}
