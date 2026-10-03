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

console.log('— analysis profile equips the model for trade-off / business tasks —');
{
  const a = systemAddendumFor('analysis');
  check('analysis has a substantial profile', a.length > 500);
  check('marks it as NOT a coding task', a.includes('NOT a coding task'));
  check('prescribes options', /OPTIONS/.test(a));
  check('prescribes weighted criteria', /CRITERIA/.test(a) && /[Ww]eight/.test(a));
  check('demands a single recommendation', /Recommend ONE|Recommend\b/.test(a));
  check('covers trade-offs explicitly', /trade-?off/i.test(a));
  check('covers business plans', /business plan/i.test(a));
  check('forbids inventing numbers/citations', /NEVER invent/.test(a));
  check('gets no delegation nudge (not read-heavy)', !a.includes('SEPARATE context window'));
}

console.log('— web automation / desktop control profiles —');
{
  const web = systemAddendumFor('web');
  check('web has its profile header', web.includes('## Task profile: web automation'));
  check('web teaches snapshot → act by ref → verify', web.includes('browser_snapshot') && web.includes('ref') && web.includes('Verify'));
  check('web prefers browser over curl', /curl/.test(web));
  check('web points long jobs to browser_agent and background goals to mission_start', web.includes('browser_agent') && web.includes('mission_start'));
  check('web uses the vault for logins', web.includes('browser_fill_secret'));
  check('web covers Sentinel + untrusted content + evidence', web.includes('Sentinel') && web.includes('untrusted') && web.includes('evidence'));
  check('web gets no delegation nudge', !web.includes('Keep your context small'));
  const desk = systemAddendumFor('desktop');
  check('desktop has its profile header', desk.includes('## Task profile: desktop control'));
  check('desktop explains screenshot-pixel coordinates + locate', desk.includes('SCREENSHOT pixels') && desk.includes('computer_use_locate'));
  check('desktop gets no delegation nudge', !desk.includes('Keep your context small'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
