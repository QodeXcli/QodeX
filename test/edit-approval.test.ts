/**
 * Tests for src/tools/filesystem/edit-approval.ts (answer interpretation).
 * Run: node --experimental-strip-types test/edit-approval.test.ts
 */
import { interpretApprovalAnswer, reviseResult, APPROVE_OPTIONS } from '../src/tools/filesystem/edit-approval.ts';

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log('— accept —');
check('"accept" → accept', interpretApprovalAnswer('accept') === 'accept');
check('"yes" → accept', interpretApprovalAnswer('yes') === 'accept');
check('"y" → accept', interpretApprovalAnswer('y') === 'accept');
check('"always" → accept', interpretApprovalAnswer('always') === 'accept');

console.log('— edit —');
check('"edit" → edit', interpretApprovalAnswer('edit') === 'edit');
check('"e" → edit', interpretApprovalAnswer('e') === 'edit');

console.log('— revise (continue) —');
check('"continue" → revise', interpretApprovalAnswer('continue') === 'revise');
check('"c" → revise', interpretApprovalAnswer('c') === 'revise');
check('"revise" → revise', interpretApprovalAnswer('revise') === 'revise');

console.log('— reject (safe default) —');
check('"no" → reject', interpretApprovalAnswer('no') === 'reject');
check('"n" → reject', interpretApprovalAnswer('n') === 'reject');
check('"reject" → reject', interpretApprovalAnswer('reject') === 'reject');
check('unknown → reject (safe)', interpretApprovalAnswer('zzz') === 'reject');
check('empty → reject (safe)', interpretApprovalAnswer('') === 'reject');
check('case-insensitive ACCEPT', interpretApprovalAnswer('ACCEPT') === 'accept');
check('whitespace tolerated', interpretApprovalAnswer('  edit  ') === 'edit');

console.log('— reviseResult shape —');
const r = reviseResult('wp-content/plugins/x/handler.php');
check('reviseResult isError', r.isError === true);
check('reviseResult names the file', r.content.includes('handler.php'));
check('reviseResult tells model NOT to repeat', r.content.includes('Do NOT re-apply'));

console.log('— "always" is an offered option (was missing → edits could never be remembered) —');
check('APPROVE_OPTIONS includes "always"', APPROVE_OPTIONS.includes('always'));
check('"always" still maps to accept branch', interpretApprovalAnswer('always') === 'accept');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
