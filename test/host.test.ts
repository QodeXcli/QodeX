import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/host/jobs.js';
import { startHostServer } from '../src/host/server.js';
import { bindAllowed, bearerOk } from '../src/host/token.js';

const token = 'a'.repeat(32);

describe('self-hosted presence', () => {
  it('refuses a short token and checks the bearer in constant length', () => {
    expect(bindAllowed('0.0.0.0', 'short').ok).toBe(false);
    expect(bindAllowed('127.0.0.1', token).ok).toBe(true);
    expect(bearerOk('Bearer ' + token, token)).toBe(true);
    expect(bearerOk('Bearer nope', token)).toBe(false);
  });

  it('keeps the job after the client has the id, and never claims a cloud', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qodex-host-'));
    const store = new JobStore(path.join(dir, 'jobs.json'));
    await store.load();
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const server = await startHostServer({
      host: '127.0.0.1',
      port: 0,
      token,
      store,
      run: async () => {
        await gate;
        return { state: 'done', text: 'still here' };
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const health = await fetch(base + '/v1/health');
      expect(await health.json()).toMatchObject({ cloud: false, kind: 'self-hosted' });
      const denied = await fetch(base + '/v1/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"x"}' });
      expect(denied.status).toBe(401);
      const posted = await fetch(base + '/v1/jobs', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'ship it' }),
      });
      expect(posted.status).toBe(202);
      const { id } = await posted.json() as { id: string };
      const queued = await fetch(base + '/v1/jobs/' + id, { headers: { authorization: 'Bearer ' + token } });
      const before = await queued.json() as { state: string };
      expect(['queued', 'running']).toContain(before.state);
      release();
      let state = before.state;
      for (let i = 0; i < 20 && state !== 'done'; i++) {
        await new Promise(r => setTimeout(r, 20));
        const again = await fetch(base + '/v1/jobs/' + id, { headers: { authorization: 'Bearer ' + token } });
        state = (await again.json() as { state: string; result?: string }).state;
      }
      const final = await (await fetch(base + '/v1/jobs/' + id, { headers: { authorization: 'Bearer ' + token } })).json() as { state: string; result?: string };
      expect(final.state).toBe('done');
      expect(final.result).toBe('still here');
    } finally {
      release();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
