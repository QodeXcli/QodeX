import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseReceipt, formatReceipt, buildGroundTruthReceipt, readReceiptFile } from '../src/schedule/receipt.ts';

describe('parseReceipt — proof-carrying autonomy', () => {
  it('parses a fenced qodex-receipt JSON block', () => {
    const out = [
      'did the work …',
      'VERIFIED-PR: opened https://github.com/x/y/pull/12',
      '```qodex-receipt',
      '{"status":"opened","branch":"qodex/auto/fix-flaky","prUrl":"https://github.com/x/y/pull/12",',
      ' "verification":[{"command":"npm test","passed":true},{"command":"tsc","passed":true}],',
      ' "filesChanged":["src/a.ts","test/a.test.ts"],"summary":"deflaked the auth test"}',
      '```',
    ].join('\n');
    const r = parseReceipt(out)!;
    expect(r.status).toBe('opened');
    expect(r.prUrl).toBe('https://github.com/x/y/pull/12');
    expect(r.branch).toBe('qodex/auto/fix-flaky');
    expect(r.verification).toEqual([{ command: 'npm test', passed: true }, { command: 'tsc', passed: true }]);
    expect(r.filesChanged).toEqual(['src/a.ts', 'test/a.test.ts']);
  });

  it('falls back to the VERIFIED-PR headline when there is no JSON block', () => {
    expect(parseReceipt('blah\nVERIFIED-PR: opened https://h/pr/9')).toEqual({ status: 'opened', prUrl: 'https://h/pr/9' });
    expect(parseReceipt('VERIFIED-PR: blocked — tests still red')).toEqual({ status: 'blocked', reason: 'tests still red' });
  });

  it('returns null when there is neither a block nor a headline', () => {
    expect(parseReceipt('just some normal output, nothing structured')).toBeNull();
  });

  it('is robust to malformed JSON (falls back, never throws)', () => {
    const out = '```qodex-receipt\n{not valid json,,,}\n```\nVERIFIED-PR: opened https://h/pr/3';
    expect(parseReceipt(out)).toEqual({ status: 'opened', prUrl: 'https://h/pr/3' });
  });

  it('drops verification entries it cannot trust (no command) and coerces passed to bool', () => {
    const out = '```qodex-receipt\n{"status":"opened","verification":[{"command":"npm test","passed":1},{"passed":true}]}\n```';
    const r = parseReceipt(out)!;
    expect(r.verification).toEqual([{ command: 'npm test', passed: true }]); // second dropped (no command)
  });
});

describe('formatReceipt — compact + scannable', () => {
  it('renders status, PR, verification and files', () => {
    const s = formatReceipt({
      status: 'opened', prUrl: 'https://h/pr/1', branch: 'b',
      verification: [{ command: 'npm test', passed: true }, { command: 'eslint', passed: false }],
      filesChanged: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(s).toContain('🧾 Receipt');
    expect(s).toContain('✅ opened');
    expect(s).toContain('PR: https://h/pr/1');
    expect(s).toContain('✓ npm test');
    expect(s).toContain('✗ eslint');
    expect(s).toContain('(+1)'); // 5 files, 4 shown
  });

  it('shows the block reason for a blocked run', () => {
    const s = formatReceipt({ status: 'blocked', reason: 'typecheck failed' });
    expect(s).toContain('⛔ blocked');
    expect(s).toContain('reason: typecheck failed');
  });
});

describe('buildGroundTruthReceipt — QodeX-measured facts', () => {
  it('dedupes verification by command keeping the LAST result (repair loop)', () => {
    const r = buildGroundTruthReceipt({
      status: 'opened',
      verification: [
        { command: 'tsc', passed: false },   // first attempt failed
        { command: 'tsc', passed: true },    // after repair: passed → this wins
        { command: 'npm test', passed: true },
      ],
      filesChanged: ['a.ts', 'a.ts', 'b.ts'],
    });
    expect(r.verification).toEqual([{ command: 'tsc', passed: true }, { command: 'npm test', passed: true }]);
    expect(r.filesChanged).toEqual(['a.ts', 'b.ts']); // deduped
  });

  it('omits empty arrays', () => {
    const r = buildGroundTruthReceipt({ status: 'done', verification: [], filesChanged: [] });
    expect(r.verification).toBeUndefined();
    expect(r.filesChanged).toBeUndefined();
  });
});

describe('readReceiptFile — the ground-truth handshake', () => {
  it('round-trips a receipt QodeX wrote to disk; missing file → null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcpt-'));
    try {
      const file = path.join(dir, 'r.json');
      const receipt = buildGroundTruthReceipt({ status: 'opened', prUrl: 'https://h/pr/7', filesChanged: ['x.ts'], verification: [{ command: 'tsc', passed: true }] });
      await fs.writeFile(file, JSON.stringify(receipt));
      expect(await readReceiptFile(file)).toEqual(receipt);
      expect(await readReceiptFile(path.join(dir, 'nope.json'))).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
