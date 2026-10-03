/**
 * Tests for src/agent/completion-gate.ts (completion-claim verification gate).
 * Run: node --experimental-strip-types test/completion-gate.test.ts
 */
import {
  extractCompletionClaims,
  gatherSessionEvidence,
  checkCompletionClaims,
  evaluateCompletion,
  type MsgLike,
} from '../src/agent/completion-gate.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const editOk = (name: string): MsgLike => ({ role: 'tool', name, content: 'Applied 1 edit (syntax validated)' });
const editErr = (name: string): MsgLike => ({ role: 'tool', name, content: '[SYNTAX_REJECTED] would break file' });
const shellRun = (cmd: string): MsgLike => ({ role: 'assistant', tool_calls: [{ function: { name: 'shell', arguments: JSON.stringify({ command: cmd }) } }] });
const shellOut = (out: string): MsgLike => ({ role: 'tool', name: 'shell', content: out });

console.log('— claim extraction (EN + FA) —');
{
  check('detects "I fixed the bug"', extractCompletionClaims('I fixed the bug in HeroVideo').claimsFixOrChange);
  check('detects persian "اصلاح کردم"', extractCompletionClaims('باگ رو اصلاح کردم').claimsFixOrChange);
  check('detects "tests pass"', extractCompletionClaims('All tests pass now').claimsTestsPass);
  check('detects persian "تست‌ها پاس"', extractCompletionClaims('تست‌ها پاس شدند').claimsTestsPass);
  check('no claim in a plain analysis', !extractCompletionClaims('Here is what the code does.').claimsFixOrChange && !extractCompletionClaims('Here is what the code does.').claimsTestsPass);
  check('detects "I created"', extractCompletionClaims("I've created the new component").claimsFixOrChange);
  check('detects persian "ساختم"', extractCompletionClaims('کامپوننت جدید رو ساختم').claimsFixOrChange);
}

console.log('— evidence gathering —');
{
  const e1 = gatherSessionEvidence([editOk('edit_text')]);
  check('successful edit counts', e1.didSuccessfulEdit === true);
  const e2 = gatherSessionEvidence([editErr('edit_text')]);
  check('rejected edit does NOT count as success', e2.didSuccessfulEdit === false);
  const e3 = gatherSessionEvidence([shellRun('npm test'), shellOut('5 passing')]);
  check('test runner in command → didRunTests', e3.didRunTests === true);
  check('shell run recorded', e3.didRunShell === true);
  const e4 = gatherSessionEvidence([shellRun('ls -la')]);
  check('non-test shell does NOT set didRunTests', e4.didRunTests === false);
  const e5 = gatherSessionEvidence([shellOut('Test Suite: 12 passed, 0 failed')]);
  check('test output in result → didRunTests', e5.didRunTests === true);
  const e6 = gatherSessionEvidence([{ role: 'tool', name: 'multi_file_edit', content: 'wrote 3 files' }]);
  check('multi_file_edit success counts as edit', e6.didSuccessfulEdit === true);
}

console.log('— gate decision —');
{
  // claim tests pass, no test ran → flag
  const r1 = checkCompletionClaims({ claimsFixOrChange: false, claimsTestsPass: true }, { didSuccessfulEdit: true, didRunTests: false, didRunShell: false });
  check('tests-claimed-but-not-run is flagged', r1 !== null && r1.includes('[COMPLETION_GATE]'));
  check('flag explains the tests problem', r1!.toLowerCase().includes('test'));

  // claim fix, no edit → flag
  const r2 = checkCompletionClaims({ claimsFixOrChange: true, claimsTestsPass: false }, { didSuccessfulEdit: false, didRunTests: false, didRunShell: false });
  check('fix-claimed-but-no-edit is flagged', r2 !== null && r2.includes('no file edit'));

  // claim fix WITH edit → pass
  const r3 = checkCompletionClaims({ claimsFixOrChange: true, claimsTestsPass: false }, { didSuccessfulEdit: true, didRunTests: false, didRunShell: false });
  check('fix-claimed-with-edit passes (null)', r3 === null);

  // claim tests WITH test run → pass
  const r4 = checkCompletionClaims({ claimsFixOrChange: false, claimsTestsPass: true }, { didSuccessfulEdit: true, didRunTests: true, didRunShell: true });
  check('tests-claimed-with-run passes (null)', r4 === null);

  // no claims → pass
  const r5 = checkCompletionClaims({ claimsFixOrChange: false, claimsTestsPass: false }, { didSuccessfulEdit: false, didRunTests: false, didRunShell: false });
  check('no claims → null', r5 === null);
}

console.log('— end-to-end evaluateCompletion —');
{
  // The hero-task failure: "I fixed it" but only reads happened, no edit.
  const lie = evaluateCompletion('باگ رو پیدا و اصلاح کردم', [
    { role: 'assistant', tool_calls: [{ function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', name: 'read_file', content: '119 lines...' },
  ]);
  check('lie (fix claim, only reads) is bounced', lie !== null);

  // Honest: claim + real edit → pass.
  const honest = evaluateCompletion('I fixed the off-by-one in parser', [
    editOk('edit_text'),
  ]);
  check('honest fix (claim + edit) passes', honest === null);

  // Pure analysis with no claim → never bothered.
  const analysis = evaluateCompletion('This module parses CSV files and validates headers.', [
    { role: 'tool', name: 'read_file', content: '...' },
  ]);
  check('analysis with no claim → null', analysis === null);

  // "tests pass" with a real test run → pass.
  const tested = evaluateCompletion('Done — tests pass.', [
    editOk('write_file'), shellRun('npx vitest run'), shellOut('Test Files 3 passed'),
  ]);
  check('tests-claimed with real run passes', tested === null);
}

console.log('— real-world actions (browser / desktop / workflow / mission) are evidence —');
{
  const call = (name: string, args: Record<string, unknown> = {}, id = name): MsgLike =>
    ({ role: 'assistant', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
  const out = (name: string, content: string, id = name): MsgLike => ({ role: 'tool', name, content, tool_call_id: id });

  check('"I added it to the cart" + browser_click passes',
    evaluateCompletion('I added it to the cart.', [call('browser_click'), out('browser_click', '✓ clicked Add to cart')]) === null);
  check('persian "سفارش رو ثبت کردم" + browser action passes',
    evaluateCompletion('سفارش رو ثبت کردم', [call('browser_click'), out('browser_click', '✓ clicked')]) === null);
  check('persian "سفارش رو ثبت کردم" with nothing done is bounced',
    (evaluateCompletion('سفارش رو ثبت کردم', []) ?? '').includes('[COMPLETION_GATE]'));
  check('workflow_run success counts', gatherSessionEvidence([call('workflow_run'), out('workflow_run', 'Replayed 6 steps')]).didSuccessfulAction === true);
  check('browser_login / vault_generate_and_fill success counts',
    gatherSessionEvidence([call('browser_login'), out('browser_login', '✓ Signed in to x.com')]).didSuccessfulAction === true
    && gatherSessionEvidence([call('vault_generate_and_fill'), out('vault_generate_and_fill', '✓ Generated a 20-character password')]).didSuccessfulAction === true);
  check('a failed browser_login does NOT count', gatherSessionEvidence([call('browser_login'), out('browser_login', '[LOGIN_FAILED] x.com did not accept')]).didSuccessfulAction === false);
  check('mission_start success counts',gatherSessionEvidence([call('mission_start'), out('mission_start', 'Mission m_1 started')]).didSuccessfulAction === true);
  check('computer_use_type counts', gatherSessionEvidence([call('computer_use_type'), out('computer_use_type', 'typed')]).didSuccessfulAction === true);
  check('observation (browser_snapshot) does NOT count', gatherSessionEvidence([call('browser_snapshot'), out('browser_snapshot', 'Page: x')]).didSuccessfulAction === false);
  check('failed action ([STALE_REF]) does NOT count', gatherSessionEvidence([call('browser_click'), out('browser_click', '[STALE_REF] e9 not found')]).didSuccessfulAction === false);
  check('a code-fix claim is NOT backed by a mere browser visit',
    (evaluateCompletion('I fixed the layout bug', [call('browser_navigate'), out('browser_navigate', 'Page: Home')]) ?? '').includes('no file edit'));
  // The platform modules report success with [CODE]s too — they are evidence, not errors.
  check('[MISSION_STARTED] mission_start counts', gatherSessionEvidence([call('mission_start'), out('mission_start', '[MISSION_STARTED] Mission m_1 is now running')]).didSuccessfulAction === true);
  check('[BROWSER_AGENT_DONE] browser_agent counts', gatherSessionEvidence([call('browser_agent'), out('browser_agent', '[BROWSER_AGENT_DONE] 5 tool call(s)')]).didSuccessfulAction === true);
  check('[MISSION_FAILED] does NOT count', gatherSessionEvidence([call('mission_start'), out('mission_start', '[MISSION_FAILED] Mission m_1 finished with status failed.')]).didSuccessfulAction === false);
  check('a "✗ Workflow … stopped" replay does NOT count', gatherSessionEvidence([call('workflow_run'), out('workflow_run', '✗ Workflow "x" stopped at step 2/4: boom')]).didSuccessfulAction === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
