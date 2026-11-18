/**
 * Jobs live on the host. The client may disconnect. The file is the queue.
 */
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { clampTurns, jobDone, MAX_PAUSES, waitForRateLimit } from './continue.js';

export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'held' | 'error';

export interface HostJob {
  id: string;
  prompt: string;
  project: string;
  state: JobState;
  turns: number;
  maxTurns: number;
  pauses: number;
  resumeAt?: string;
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
      job.turns ??= 0;
      job.maxTurns ??= clampTurns(job.maxTurns);
      job.pauses ??= 0;
    }
  }

  list(): HostJob[] {
    return this.jobs.map(j => ({ ...j }));
  }

  get(id: string): HostJob | null {
    const job = this.jobs.find(j => j.id === id);
    return job ? { ...job } : null;
  }

  async add(input: { prompt: string; project: string; maxTurns?: number }): Promise<HostJob> {
    const job: HostJob = {
      id: randomBytes(8).toString('hex'),
      prompt: input.prompt,
      project: input.project,
      state: 'queued',
      turns: 0,
      maxTurns: clampTurns(input.maxTurns),
      pauses: 0,
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
      const next = jobs.find(j => j.state === 'queued' || (j.state === 'paused' && !!j.resumeAt && Date.parse(j.resumeAt) <= Date.now()));
      if (!next) return;
      next.state = 'running';
      claimed = { ...next };
    });
    return claimed;
  }

  async park(id: string, resumeAt: string, error: string): Promise<void> {
    await this.mutate(jobs => {
      const job = jobs.find(j => j.id === id);
      if (!job) return;
      job.state = 'paused';
      job.resumeAt = resumeAt;
      job.error = error;
      job.pauses += 1;
    });
  }

  async requeue(id: string, result: string): Promise<void> {
    await this.mutate(jobs => {
      const job = jobs.find(j => j.id === id);
      if (!job) return;
      job.state = 'queued';
      job.result = result;
      job.turns += 1;
      job.resumeAt = undefined;
      job.error = undefined;
    });
  }

  async finish(id: string, patch: { state: 'done' | 'held' | 'error'; result?: string; error?: string }): Promise<void> {
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

export async function drainOne(store: JobStore, run: (job: HostJob) => Promise<{ state: 'done' | 'held' | 'continue'; text: string }>): Promise<HostJob | null> {
  const job = await store.claim();
  if (!job) return null;
  try {
    const out = await run(job);
    if (out.state === 'held') {
      await store.finish(job.id, { state: 'held', result: out.text });
    } else if (out.state === 'done' || jobDone(out.text)) {
      await store.finish(job.id, { state: 'done', result: out.text });
    } else if (job.turns + 1 >= job.maxTurns) {
      await store.finish(job.id, {
        state: 'error',
        result: out.text,
        error: `stopped after ${job.maxTurns} turns without JOB_DONE. The project is not finished.`,
      });
    } else {
      await store.requeue(job.id, out.text);
    }
  } catch (e: any) {
    const wait = waitForRateLimit(e);
    if (wait != null && job.pauses + 1 <= MAX_PAUSES) {
      await store.park(job.id, new Date(Date.now() + wait).toISOString(), e?.message ?? String(e));
    } else if (wait != null) {
      await store.finish(job.id, { state: 'error', error: `rate limit returned ${MAX_PAUSES} times. Stopped. The project is not finished.` });
    } else {
      await store.finish(job.id, { state: 'error', error: e?.message ?? String(e) });
    }
  }
  return store.get(job.id);
}
