/**
 * Universal tool-result spill guard (src/agent/tool-spill.ts) + the
 * http_request head+tail body-excerpt default (src/tools/web/http-request.ts).
 *
 * The contract under test: an oversized tool result NEVER enters the model
 * context whole. The full content lands on disk, the context gets
 * head + "[N chars spilled — full output: <path>]" + tail, and the model is
 * told exactly how to read the rest (read_file with offset/limit). Under-limit
 * results and config 0 pass through untouched — no double truncation.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { applySpillGuard, pruneSpillDir, SPILL_MARK } from '../src/agent/tool-spill.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { HttpRequestTool } from '../src/tools/web/http-request.js';
import type { ToolContext } from '../src/tools/base.js';

let baseDir: string;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qodex-spill-'));
});
afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

const OPTS = () => ({ maxResultChars: 16_000, baseDir });

describe('applySpillGuard', () => {
  it('spills an over-limit result: file exists with COMPLETE content, context gets head+tail+marker with the real path', async () => {
    const head = 'STATUS: 200 OK — headers first\n';
    const tail = '\nTRAILING ERROR: sitemap entry 2103 missing';
    const content = head + 'x'.repeat(60_000) + tail;

    const r = await applySpillGuard('http_request', 'sess-1', content, OPTS());

    expect(r.spilled).toBe(true);
    expect(r.spillPath).toBeTruthy();
    // Full, byte-identical content on disk
    const onDisk = await fs.readFile(r.spillPath!, 'utf-8');
    expect(onDisk).toBe(content);
    // Spill file lives under <baseDir>/<sessionId>/<seq>-<tool>.txt
    expect(r.spillPath).toContain(path.join(baseDir, 'sess-1'));
    expect(r.spillPath!.endsWith('-http_request.txt')).toBe(true);

    // Context content: head kept, tail kept, marker carries size + REAL path + retrieval hint
    expect(r.content.startsWith(head)).toBe(true);
    expect(r.content.endsWith(tail)).toBe(true);
    expect(r.content).toContain(`${content.length} ${SPILL_MARK} ${r.spillPath}`);
    expect(r.content).toContain('read_file with offset/limit');
    // And it actually shrank — that's the whole point
    expect(r.content.length).toBeLessThan(8_000);
  });

  it('leaves an under-limit result untouched (no double truncation of self-capping tools)', async () => {
    const content = 'y'.repeat(15_999);
    const r = await applySpillGuard('shell', 'sess-1', content, OPTS());
    expect(r.spilled).toBe(false);
    expect(r.content).toBe(content);
    // Nothing written for this session
    await expect(fs.readdir(path.join(baseDir, 'sess-1'))).rejects.toThrow();
  });

  it('maxResultChars 0 disables the guard entirely', async () => {
    const content = 'z'.repeat(100_000);
    const r = await applySpillGuard('web_fetch', 'sess-1', content, { maxResultChars: 0, baseDir });
    expect(r.spilled).toBe(false);
    expect(r.content).toBe(content);
  });

  it('is idempotent: already-spilled content (marker present) is not spilled again', async () => {
    const first = await applySpillGuard('grep', 'sess-2', 'A'.repeat(40_000), OPTS());
    expect(first.spilled).toBe(true);
    // Force it back through with an absurdly small limit — the marker guards it
    const second = await applySpillGuard('grep', 'sess-2', first.content, { maxResultChars: 100, baseDir });
    expect(second.spilled).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('preserves isError/metadata at the loop boundary (guard only replaces content)', async () => {
    // The loop applies `result = { ...result, content: spill.content }` — mirror
    // that here to pin the contract: isError and metadata survive a spill.
    const result = {
      content: '[TOOL_ERROR] giant stack trace\n' + 'frame\n'.repeat(10_000),
      isError: true,
      metadata: { status: 500, bytes: 12345 },
    };
    const spill = await applySpillGuard('shell', 'sess-3', result.content, OPTS());
    expect(spill.spilled).toBe(true);
    const rewritten = { ...result, content: spill.content };
    expect(rewritten.isError).toBe(true);
    expect(rewritten.metadata).toEqual({ status: 500, bytes: 12345 });
    expect(rewritten.content).toContain(SPILL_MARK);
    expect(rewritten.content.startsWith('[TOOL_ERROR]')).toBe(true);
  });

  it('config default is 16000 chars', () => {
    expect(DEFAULT_CONFIG.tools?.maxResultChars).toBe(16_000);
  });

  it('prunes oldest spill files when the dir exceeds the byte budget', async () => {
    const dir = path.join(baseDir, 'sess-old');
    await fs.mkdir(dir, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `000${i}-shell.txt`);
      await fs.writeFile(p, 'k'.repeat(1_000));
      // Stagger mtimes so "oldest" is well-defined
      await fs.utimes(p, new Date(now - (10 - i) * 60_000), new Date(now - (10 - i) * 60_000));
    }
    const pruned = await pruneSpillDir(baseDir, 2_500); // 5KB present, 2.5KB budget
    expect(pruned).toBeGreaterThanOrEqual(2);
    const left = await fs.readdir(dir);
    // Newest files survive
    expect(left).toContain('0004-shell.txt');
    expect(left).not.toContain('0000-shell.txt');
  });
});

describe('http_request body excerpt (polite at the source)', () => {
  let server: http.Server;
  let port: number;
  const BIG_BODY = '<html>' + 'chunk-'.repeat(50_000) + 'THE-VERY-END</html>'; // ~300KB

  const mkCtx = (): ToolContext => ({
    cwd: process.cwd(),
    sessionId: 'test',
    transaction: {} as any,
    permissions: { check: () => ({ ok: true }) } as any,
    askUser: async () => 'allow',
    emit: () => {},
    signal: new AbortController().signal,
  } as ToolContext);

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(BIG_BODY);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('defaults to a head+tail excerpt with total-bytes note — status and headers stay complete', async () => {
    const tool = new HttpRequestTool();
    const r = await tool.execute(
      { url: `http://127.0.0.1:${port}/page`, allow_local: true } as any,
      mkCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Status: 200');
    expect(r.content).toContain('<html>'); // head kept
    expect(r.content).toContain('THE-VERY-END</html>'); // tail kept
    expect(r.content).toContain('http_request body excerpt');
    expect(r.content).toContain('fullBody: true');
    expect(r.content).toContain(`${BIG_BODY.length.toLocaleString()} bytes total`);
    // The excerpt keeps the whole result comfortably small (~6KB body + envelope)
    expect(r.content.length).toBeLessThan(10_000);
    expect((r.metadata as any).bytes).toBe(BIG_BODY.length);
  });

  it('fullBody: true bypasses the excerpt and returns the entire body', async () => {
    const tool = new HttpRequestTool();
    const r = await tool.execute(
      { url: `http://127.0.0.1:${port}/page`, allow_local: true, fullBody: true } as any,
      mkCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(BIG_BODY);
    expect(r.content).not.toContain('http_request body excerpt');
  });

  it('small bodies are returned whole with no excerpt marker', async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    server = http.createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;

    const tool = new HttpRequestTool();
    const r = await tool.execute(
      { url: `http://127.0.0.1:${port}/missing`, allow_local: true } as any,
      mkCtx(),
    );
    expect(r.content).toContain('Status: 404');
    expect(r.content).toContain('not found');
    expect(r.content).not.toContain('http_request body excerpt');
  });

  it('schema exposes fullBody as a boolean with guidance', () => {
    const schema = new HttpRequestTool().schema();
    const props = (schema.function.parameters as any).properties;
    expect(props.fullBody).toBeDefined();
    expect(props.fullBody.type).toBe('boolean');
    expect(props.fullBody.description).toMatch(/head\+tail excerpt/);
  });
});
