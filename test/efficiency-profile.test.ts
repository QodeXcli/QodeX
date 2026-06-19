/**
 * Tests for src/agent/efficiency-profile.ts.
 * Run: node --experimental-strip-types test/efficiency-profile.test.ts
 */
import { efficiencyDefaults, resolveSetting } from '../src/agent/efficiency-profile.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— balanced (default, OFF) keeps existing behavior —');
{
  const b = efficiencyDefaults(false);
  check('minTurns 3', b.agingMinTurns === 3);
  check('maxChars 8000', b.agingMaxChars === 8000);
  check('compact threshold 0.75', b.compactThreshold === 0.75);
}

console.log('— aggressive (efficient ON) tightens all three —');
{
  const a = efficiencyDefaults(true);
  check('minTurns 2 (sooner)', a.agingMinTurns === 2);
  check('maxChars 4000 (more aged)', a.agingMaxChars === 4000);
  check('compact threshold 0.60 (earlier)', a.compactThreshold === 0.60);
  const b = efficiencyDefaults(false);
  check('aggressive is strictly tighter than balanced', a.agingMinTurns < b.agingMinTurns && a.agingMaxChars < b.agingMaxChars && a.compactThreshold < b.compactThreshold);
}

console.log('— resolveSetting: explicit user value always wins —');
{
  check('explicit number wins over profile', resolveSetting(5000, 4000) === 5000);
  check('explicit 0 is honored (finite)', resolveSetting(0, 4000) === 0);
  check('undefined → profile default', resolveSetting(undefined, 4000) === 4000);
  check('null → profile default', resolveSetting(null, 4000) === 4000);
  check('NaN → profile default', resolveSetting(NaN, 4000) === 4000);
  check('string → profile default', resolveSetting('8000', 4000) === 4000);
}

console.log('— returned objects are copies (no shared mutation) —');
{
  const a = efficiencyDefaults(true); a.agingMaxChars = 1;
  check('mutating result does not poison the next call', efficiencyDefaults(true).agingMaxChars === 4000);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
