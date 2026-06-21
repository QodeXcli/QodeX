import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createArtifact, updateArtifact, rollbackArtifact, type WriteFn } from '../src/artifacts/store.js';
import { startLive, stopLive, stopAllLive, listLive, getLive } from '../src/artifacts/live-registry.js';

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-live-'));
  dirs.push(d);
  return d;
}
// A plain filesystem WriteFn (the live test doesn't need the journaled transaction).
const write: WriteFn = async (abs, content) => {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
};

afterEach(async () => {
  await stopAllLive();
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {});
});

async function waitUntil(fn: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return fn();
}

/** Consume an SSE channel, counting `reload` events. Returns a stop() fn. */
async function openSse(url: string, onReload: () => void): Promise<() => void> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  void (async () => {
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (/^event:\s*reload/m.test(block)) onReload();
        }
      }
    } catch { /* aborted */ }
  })();
  return () => ac.abort();
}

describe('live artifact server (end-to-end, in-process)', () => {
  it('serves current version, hot-reloads on update and rollback', async () => {
    const cwd = await tmpDir();
    const { manifest } = await createArtifact(cwd, { title: 'Live Demo', type: 'html', content: '<html><body><h1>V1</h1></body></html>' }, write);
    const id = manifest.id;

    const info = await startLive({ cwd, id, port: 0 }); // port 0 → ephemeral, no collisions
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    // GET / returns v1 + the injected live client.
    const page1 = await (await fetch(info.url)).text();
    expect(page1).toContain('V1');
    expect(page1).toContain('EventSource');

    // Listen on the SSE channel.
    let reloads = 0;
    const stopSse = await openSse(`${info.url}__live__`, () => { reloads++; });
    await new Promise(r => setTimeout(r, 100)); // let the connection establish

    // Update → expect a reload push, and GET / now shows v2.
    await updateArtifact(cwd, { id, content: '<html><body><h1>V2</h1></body></html>' }, write);
    expect(await waitUntil(() => reloads >= 1)).toBe(true);
    const page2 = await (await fetch(info.url)).text();
    expect(page2).toContain('V2');
    expect(page2).not.toContain('<h1>V1</h1>');

    // Rollback → another reload, GET / shows v1 again.
    const before = reloads;
    await rollbackArtifact(cwd, id, 1, write);
    expect(await waitUntil(() => reloads > before)).toBe(true);
    const page3 = await (await fetch(info.url)).text();
    expect(page3).toContain('V1');

    stopSse();
    expect(await stopLive(id)).toBe(true);
  });

  it('shows an error overlay (not a crash) when the artifact is deleted, and serves a 200', async () => {
    const cwd = await tmpDir();
    const { manifest } = await createArtifact(cwd, { title: 'Doomed', type: 'html', content: '<html><body>ok</body></html>' }, write);
    const id = manifest.id;
    const info = await startLive({ cwd, id, port: 0 });

    await fs.rm(path.join(cwd, '.qodex', 'artifacts', id), { recursive: true, force: true });

    const res = await fetch(info.url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Artifact preview unavailable');
    expect(body).toContain('EventSource'); // overlay self-recovers
  });
});

describe('live registry', () => {
  it('reuses an existing server for the same id (keeps the open tab)', async () => {
    const cwd = await tmpDir();
    const { manifest } = await createArtifact(cwd, { title: 'Reuse Me', type: 'html', content: '<html><body>x</body></html>' }, write);
    const id = manifest.id;

    const a = await startLive({ cwd, id, port: 0 });
    const b = await startLive({ cwd, id, port: 0 });
    expect(b.url).toBe(a.url);        // same handle reused, not a second server
    expect(b.port).toBe(a.port);
    expect(listLive().filter(s => s.id === id)).toHaveLength(1);
    expect(getLive(id)).toBeTruthy();

    expect(await stopLive(id)).toBe(true);
    expect(getLive(id)).toBeUndefined();
    expect(await stopLive(id)).toBe(false); // idempotent
  });

  it('stopAllLive tears everything down', async () => {
    const cwd = await tmpDir();
    const a = await createArtifact(cwd, { title: 'One', type: 'html', content: '<html><body>1</body></html>' }, write);
    const b = await createArtifact(cwd, { title: 'Two', type: 'html', content: '<html><body>2</body></html>' }, write);
    await startLive({ cwd, id: a.manifest.id, port: 0 });
    await startLive({ cwd, id: b.manifest.id, port: 0 });
    expect(listLive().length).toBeGreaterThanOrEqual(2);
    await stopAllLive();
    expect(listLive()).toHaveLength(0);
  });
});
