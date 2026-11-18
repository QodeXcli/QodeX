/**
 * The machine that stays on. A client posts a job and may leave.
 * This process is not a cloud. `cloud` is always false.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { bearerOk } from './token.js';
import { drainOne, JobStore, type HostJob } from './jobs.js';
import { clampTurns } from './continue.js';

export interface HostServer {
  port: number;
  close: () => Promise<void>;
  store: JobStore;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > 65_536) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(raw) });
  res.end(raw);
}

export function startHostServer(opts: {
  host: string;
  port: number;
  token: string;
  store: JobStore;
  run: (job: HostJob) => Promise<{ state: 'done' | 'held' | 'continue'; text: string }>;
}): Promise<HostServer> {
  let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        while (await drainOne(opts.store, opts.run)) { /* next */ }
      } finally {
        pumping = false;
      }
    })();
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/health') {
        send(res, 200, { ok: true, kind: 'self-hosted', cloud: false });
        return;
      }
      if (!bearerOk(req.headers.authorization, opts.token)) {
        send(res, 401, { error: 'bad token' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/jobs') {
        send(res, 200, { jobs: opts.store.list().map(j => ({ id: j.id, state: j.state, createdAt: j.createdAt })) });
        return;
      }
      const one = /^\/v1\/jobs\/([a-f0-9]+)$/.exec(url.pathname);
      if (req.method === 'GET' && one) {
        const job = opts.store.get(one[1]);
        if (!job) { send(res, 404, { error: 'no such job' }); return; }
        send(res, 200, job);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/jobs') {
        const body = JSON.parse(await readBody(req) || '{}') as { prompt?: string; project?: string; maxTurns?: number };
        const prompt = (body.prompt ?? '').trim();
        if (!prompt) { send(res, 400, { error: 'prompt is empty' }); return; }
        const job = await opts.store.add({
          prompt: prompt.slice(0, 8000),
          project: (body.project ?? process.cwd()).slice(0, 500),
          maxTurns: clampTurns(body.maxTurns),
        });
        send(res, 202, { id: job.id, state: job.state, cloud: false });
        pump();
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e: any) {
      send(res, 400, { error: e?.message ?? 'bad request' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      const timer = setInterval(pump, 5_000);
      timer.unref?.();
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        store: opts.store,
        close: () => new Promise((done, fail) => {
          clearInterval(timer);
          server.close(err => err ? fail(err) : done());
        }),
      });
    });
  });
}
