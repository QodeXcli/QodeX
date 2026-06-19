/**
 * Tests for src/agent/read-ledger.ts (read-before-write gate).
 * Run: node --experimental-strip-types test/read-ledger.test.ts
 * Pure logic only — no filesystem, no loop. The loop wiring stats real files
 * and feeds mtimes into these functions.
 */
import {
  ReadLedger,
  extractMutationPaths,
  extractReadPath,
  isGatedMutationTool,
  buildGateMessage,
} from '../src/agent/read-ledger.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— gate verdicts —');
{
  const led = new ReadLedger();
  const v1 = led.check('/p/a.php', 1000);
  check('unread file is blocked', !v1.ok && (v1 as any).kind === 'unread');

  led.mark('/p/a.php', 1000);
  check('after read, same mtime passes', led.check('/p/a.php', 1000).ok);
  check('1ms mtime slack passes (fs rounding)', led.check('/p/a.php', 1001).ok);

  const v2 = led.check('/p/a.php', 1500);
  check('file changed on disk after read → stale', !v2.ok && (v2 as any).kind === 'stale');

  led.mark('/p/a.php', 1500); // model re-read (or its own write updated the ledger)
  check('re-read clears staleness', led.check('/p/a.php', 1500).ok);

  check('older mtime than recorded still passes (clock skew tolerance)', led.check('/p/a.php', 900).ok);
  check('ledger size tracks entries', led.size() === 1);
}

console.log('— path extractors —');
{
  check('edit_text is gated', isGatedMutationTool('edit_text'));
  check('multi_edit is gated', isGatedMutationTool('multi_edit'));
  check('write_file is gated', isGatedMutationTool('write_file'));
  check('edit_symbol is gated', isGatedMutationTool('edit_symbol'));
  check('multi_file_edit is gated', isGatedMutationTool('multi_file_edit'));
  check('shell is NOT gated', !isGatedMutationTool('shell'));
  check('read_file is NOT gated', !isGatedMutationTool('read_file'));

  check('edit_text → [path]',
    JSON.stringify(extractMutationPaths('edit_text', { path: 'a.php', old_string: 'x', new_string: 'y' })) === '["a.php"]');
  check('multi_file_edit → all file paths',
    JSON.stringify(extractMutationPaths('multi_file_edit', { files: [{ path: 'a.ts', edits: [] }, { path: 'b.ts', edits: [] }] })) === '["a.ts","b.ts"]');
  check('multi_file_edit with malformed files → []',
    extractMutationPaths('multi_file_edit', { files: 'oops' }).length === 0);
  check('non-gated tool → []', extractMutationPaths('grep', { pattern: 'x' }).length === 0);
  check('missing path → []', extractMutationPaths('edit_text', {}).length === 0);

  check('read_file satisfies the gate', extractReadPath('read_file', { path: 'a.php' }) === 'a.php');
  check('grep does NOT satisfy the gate (partial view)', extractReadPath('grep', { pattern: 'x', path: 'a.php' }) === null);
  check('shell does NOT satisfy the gate', extractReadPath('shell', { command: 'cat a.php' }) === null);
}

console.log('— refusal messages —');
{
  const m1 = buildGateMessage('inc/accounting.php', 'unread');
  check('unread message names the file', m1.includes('inc/accounting.php'));
  check('unread message instructs read_file', m1.includes('read_file'));
  check('unread message warns grep is insufficient', m1.toLowerCase().includes('grep'));
  check('refusal is an [ACCESS_DENIED] tool result, not a crash', m1.startsWith('[ACCESS_DENIED]'));

  const m2 = buildGateMessage('inc/accounting.php', 'stale');
  check('stale message says the file changed', m2.includes('changed on disk'));
  check('stale message instructs re-read', m2.includes('read_file'));
}

console.log('— end-to-end decision sequence (simulated session) —');
{
  // Simulates: model tries edit unread → blocked; reads → edit passes;
  // shell (sed) modifies file → next edit blocked as stale; re-read → passes.
  const led = new ReadLedger();
  const f = '/proj/inc/class-cargo-accounting.php';
  let mtime = 5000;

  const try1 = led.check(f, mtime);
  check('step1: edit before read is refused', !try1.ok && (try1 as any).kind === 'unread');

  led.mark(f, mtime); // read_file succeeded
  check('step2: edit after read passes', led.check(f, mtime).ok);

  mtime = 6000; led.mark(f, mtime); // the model's own successful edit re-marks at new mtime
  check('step3: model\u2019s own edit does not trip staleness', led.check(f, mtime).ok);

  mtime = 7000; // shell/sed or the user modified the file outside the ledger
  const try4 = led.check(f, mtime);
  check('step4: external change → stale refusal', !try4.ok && (try4 as any).kind === 'stale');

  led.mark(f, mtime); // re-read
  check('step5: re-read restores edit access', led.check(f, mtime).ok);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
