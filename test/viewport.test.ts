/**
 * Tests for src/cli/viewport.ts (tail capping + shrink detection).
 * Run: node --experimental-strip-types test/viewport.test.ts
 */
import { tailForViewport, didShrink, CLEAR_SCREEN, formatContextMeter } from '../src/cli/viewport.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— didShrink —');
{
  check('narrower cols → shrink', didShrink({ cols: 120, rows: 40 }, { cols: 80, rows: 40 }) === true);
  check('shorter rows → shrink', didShrink({ cols: 80, rows: 40 }, { cols: 80, rows: 24 }) === true);
  check('either dimension smaller → shrink', didShrink({ cols: 120, rows: 40 }, { cols: 130, rows: 24 }) === true);
  check('wider only → NOT shrink', didShrink({ cols: 80, rows: 24 }, { cols: 120, rows: 24 }) === false);
  check('taller only → NOT shrink', didShrink({ cols: 80, rows: 24 }, { cols: 80, rows: 40 }) === false);
  check('grow both → NOT shrink', didShrink({ cols: 80, rows: 24 }, { cols: 120, rows: 40 }) === false);
  check('no change → NOT shrink', didShrink({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }) === false);
}

console.log('— CLEAR_SCREEN —');
{
  check('clears screen + scrollback + homes cursor', CLEAR_SCREEN === '\x1b[2J\x1b[3J\x1b[H');
}

console.log('— tailForViewport still bounds output —');
{
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const out = tailForViewport(lines, 24, 80).split('\n');
  check('caps to roughly the visible budget', out.length <= 24 && out.length >= 6);
  check('keeps the TAIL (latest lines)', out[out.length - 1] === 'line 99');
  const wide = 'x'.repeat(400); // 5 wrapped rows at width 80
  check('counts wrapped rows for long unbroken lines', tailForViewport(wide + '\n' + wide, 12, 80).length > 0);
}

console.log('— streaming-region height invariant (no overflow → no scroll/jitter) —');
{
  // StreamingView renders the tail with ZERO chrome: exactly one element per logical
  // line, each occupying ceil(len/width) wrapped rows — the SAME measure tailForViewport
  // sums against the budget. So the real rendered height must never exceed the budget,
  // even for code-heavy text (the boxed AssistantMessage would have, which caused the
  // oscillation + non-stop scroll bug). We replicate StreamingView's height here.
  const physicalRows = (text: string, width: number) =>
    text.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / Math.max(20, width))), 0);

  const cases = [
    Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),                 // long prose
    'Here is the fix:\n\n```ts\n' + Array.from({ length: 80 }, (_, i) => `  const v${i} = compute(${i});`).join('\n') + '\n```\n', // big code block
    'x'.repeat(2000) + '\n' + 'y'.repeat(2000),                                     // unbroken wrapped lines
    '```js\n' + 'a'.repeat(500) + '\n```\nmore prose here',                         // wrapped code + prose
  ];
  for (const [rows, cols] of [[24, 80], [40, 120], [12, 60], [50, 200]] as Array<[number, number]>) {
    const budget = Math.max(6, rows - 10);
    let ok = true;
    for (const text of cases) {
      const tail = tailForViewport(text, rows, cols);
      if (physicalRows(tail, cols) > budget) ok = false;
    }
    check(`rendered tail height ≤ budget at ${rows}x${cols}`, ok);
  }
}

console.log('— formatContextMeter —');
{
  check('unknown window → empty', formatContextMeter(1000, 0) === '');
  check('zero used → empty', formatContextMeter(0, 200000) === '');
  const m = formatContextMeter(16000, 200000);
  check('shows used/window', m.includes('16k/200k'));
  check('shows percent', m.includes('8%'));
  check('has a bar', /[█░]/.test(m));
  check('full → 100%', formatContextMeter(200000, 200000).includes('100%'));
  check('over 100% capped', formatContextMeter(300000, 200000).includes('100%'));
  check('small numbers keep precision', formatContextMeter(500, 4096).includes('500/4.1k'));
}


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
