/**
 * Tests for the delegation nudge in src/llm/prompts/task-addenda.ts.
 * Run: node --experimental-strip-types test/task-addenda.test.ts
 */
import { systemAddendumFor, type TaskClass } from '../src/llm/prompts/task-addenda.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— delegation nudge appears only on read-heavy classes —');
for (const c of ['review', 'explain', 'refactor'] as TaskClass[]) {
  const a = systemAddendumFor(c);
  check(`${c} includes delegation nudge`, a.includes('delegate heavy exploration') || a.includes('SUB-AGENT'));
  check(`${c} still has its base addendum`, a.length > 200);
}

console.log('— other classes do NOT get the nudge —');
for (const c of ['feature', 'backend', 'frontend', 'debug', 'general'] as TaskClass[]) {
  const a = systemAddendumFor(c);
  check(`${c} has NO delegation nudge`, !a.includes('Keep your context small'));
}

console.log('— nudge content is precise (avoids over-delegation) —');
{
  const a = systemAddendumFor('review');
  check('mentions separate context window', a.includes('SEPARATE context window'));
  check('warns against single-file delegation', a.toLowerCase().includes('single-file') || a.toLowerCase().includes('inline'));
  check('names the task tool', a.includes('`task`'));
}

console.log('— general returns empty (unchanged behavior) —');
check('general is empty', systemAddendumFor('general') === '');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
