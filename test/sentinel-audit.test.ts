import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SentinelAudit, redactForAudit } from '../src/sentinel/audit.js';
import { classifyAction } from '../src/sentinel/policy.js';
import { DEFAULT_SENTINEL_CONFIG } from '../src/config/agent-config.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });

describe('redactForAudit', () => {
  it('redacts sensitive keys, masks secret-looking values, truncates', () => {
    const out = redactForAudit({
      url: 'https://x.example/?access_token=abcdefghijklmnop1234',
      headers: { Authorization: 'Bearer abc', 'x-trace': 'ok' },
      api_key: 'sk-live-whatever',
      text: 'card 4111 1111 1111 1111',
      fields: [{ ref: 'e1', value: 'pw' }],
      long: 'x'.repeat(1000),
    }) as any;
    expect(out.url).toContain('[redacted:url-credential]');
    expect(out.headers.Authorization).toMatch(/redacted/);
    expect(out.headers['x-trace']).toBe('ok');
    expect(out.api_key).toMatch(/redacted/);
    expect(out.text).toBe('card [redacted:card]');
    expect(out.fields[0].value).toBe('pw');
    expect(out.long.length).toBeLessThan(400);
    const hidden = redactForAudit({ text: 'hunter2', fields: [{ ref: 'e1', value: 'pw' }] }, { hideTyped: true }) as any;
    expect(hidden.text).toBe('[hidden 7 chars]');
    expect(hidden.fields[0].value).toBe('[hidden 2 chars]');
  });
});

describe('SentinelAudit', () => {
  it('appends JSONL, rotates past maxBytes and never throws', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qx-audit-'));
    dirs.push(dir);
    const a = new SentinelAudit({ dir: path.join(dir, 'sentinel'), maxBytes: 400 });
    for (let i = 0; i < 6; i++) a.record({ type: 'decision', tool: 'browser_click', action: 'allow', summary: `click #${i} ${'y'.repeat(60)}` });
    await a.flush();
    const files = (await fs.readdir(path.join(dir, 'sentinel'))).sort();
    expect(files).toEqual(['audit.1.jsonl', 'audit.jsonl']);
    const tail = await a.tail(50);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.at(-1)?.summary).toContain('click #5');
    expect(tail.at(-1)?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // An unwritable location is swallowed.
    const bad = new SentinelAudit({ dir: path.join(dir, 'file-not-dir', 'x') });
    await fs.writeFile(path.join(dir, 'file-not-dir'), 'x');
    bad.record({ type: 'decision', tool: 't' });
    await expect(bad.flush()).resolves.toBeUndefined();
    expect(await bad.tail()).toEqual([]);
  });
});

describe('shell redirects to /dev/null are reads', () => {
  it('does not treat 2>/dev/null as a config write', () => {
    expect(classifyAction('shell', { command: 'cat ~/.qodex/config.yaml 2>/dev/null' }, { config: DEFAULT_SENTINEL_CONFIG }).category).toBe(null);
    expect(classifyAction('shell', { command: 'cp ~/.qodex/config.yaml /tmp/x.yaml' }, { config: DEFAULT_SENTINEL_CONFIG }).risk).toBe('critical');
  });
});
