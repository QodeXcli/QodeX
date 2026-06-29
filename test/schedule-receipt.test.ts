import { describe, it, expect } from 'vitest';
import { parseReceipt, formatReceipt } from '../src/schedule/receipt.ts';

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
