/**
 * Completion-claim verification gate.
 *
 * The observed failure (Hamed's "sometimes it lies"): a model finishes a task by
 * asserting things it never actually did — "I fixed the bug", "tests pass", "I
 * updated the file" — when the session contains no edit, no test run, no evidence.
 * Local models do this especially at the END of a task, where the pull to produce a
 * satisfying summary outweighs the discipline to verify.
 *
 * This gate fires ONCE, right before a task would finalize: it compares the
 * COMPLETION CLAIMS in the model's final message against the EVIDENCE of what
 * actually executed this session. An unsupported claim ("tests pass" with no test
 * run; "I fixed it" with no successful edit) is bounced back as a corrective
 * observation, forcing the model to either actually do the work or retract the
 * claim. It does NOT judge whether the work is correct — only whether the model's
 * own assertions are backed by actions it actually took. Bilingual (EN + FA).
 *
 * Pure + duck-typed (messages are read structurally) so it unit-tests without the
 * loop. One-shot + soft + default-on, matching the architecture/critic gates.
 */

const EDIT_TOOLS = new Set(['edit_text', 'multi_edit', 'write_file', 'edit_symbol', 'multi_file_edit']);
const TEST_RUNNER_RE = /\b(jest|vitest|pytest|mocha|npm (run )?test|yarn test|pnpm test|go test|cargo test|phpunit|rspec|unittest|tox|gradle test|mvn test|ctest)\b/i;
const TEST_RESULT_RE = /\b(\d+ pass|passing|passed|\d+ failed|failing|test suite|tests? (ran|passed|failed)|✓|✗|PASS\b|FAIL\b)/i;
const ERROR_PREFIX_RE = /^\s*\[(ACCESS_DENIED|SYNTAX_REJECTED|MULTI_EDIT_REJECTED|ERROR|PREFLIGHT|ARCHITECTURE_GATE)/i;

export interface CompletionClaims {
  claimsFixOrChange: boolean; // "I fixed / resolved / updated / created …"
  claimsTestsPass: boolean;   // "tests pass / all green …"
}

export interface SessionEvidence {
  didSuccessfulEdit: boolean; // an edit/write tool returned non-error
  didRunTests: boolean;       // a test runner was invoked OR test output appeared
  didRunShell: boolean;       // any shell command executed
}

/** Minimal structural view of a message (works for real Message or test mocks). */
export interface MsgLike {
  role: string;
  content?: unknown;
  name?: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

const FIX_CLAIM_KEYWORDS = [
  'i fixed', "i've fixed", 'fixed the', 'resolved the', 'i resolved', 'i updated',
  "i've updated", 'i changed', 'i created', "i've created", 'i added', "i've added",
  'i implemented', 'i wrote', 'i refactored', 'i corrected', 'the fix', 'has been fixed',
  'now works', 'should now work', 'is now fixed',
  // Persian
  'اصلاح کردم', 'درست کردم', 'رفع کردم', 'رفع شد', 'حل کردم', 'حل شد', 'تغییر دادم',
  'به‌روزرسانی کردم', 'بروزرسانی کردم', 'اضافه کردم', 'ساختم', 'نوشتم', 'پیاده کردم',
  'پیاده‌سازی کردم', 'تعمیر کردم', 'برطرف کردم', 'برطرف شد', 'درستش کردم', 'اصلاحش کردم',
];

const TEST_CLAIM_KEYWORDS = [
  'tests pass', 'test passes', 'all tests pass', 'tests are passing', 'passing now',
  'tests green', 'all green', 'test suite passes', 'verified with tests', 'tests succeed',
  // Persian
  'تست‌ها پاس', 'تست پاس', 'تست‌ها سبز', 'تست‌ها رد شد', 'تست گرفتم', 'تست‌ها موفق',
  'همه تست‌ها', 'تست‌ها قبول',
];

export function extractCompletionClaims(finalText: string): CompletionClaims {
  const t = (finalText || '').toLowerCase();
  return {
    claimsFixOrChange: FIX_CLAIM_KEYWORDS.some(k => t.includes(k)),
    claimsTestsPass: TEST_CLAIM_KEYWORDS.some(k => t.includes(k)),
  };
}

export function gatherSessionEvidence(messages: MsgLike[]): SessionEvidence {
  let didSuccessfulEdit = false;
  let didRunTests = false;
  let didRunShell = false;

  for (const m of messages) {
    // Attempted tool calls (assistant side) — read shell command args for test runners.
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name ?? '';
        const args = tc.function?.arguments ?? '';
        if (name === 'shell' || name === 'auto_fix' || name === 'code_run') {
          didRunShell = true;
          if (TEST_RUNNER_RE.test(args)) didRunTests = true;
        }
      }
    }
    // Tool results (tool side) — confirm success (non-error) and scan for test output.
    if (m.role === 'tool') {
      const name = m.name ?? '';
      const content = typeof m.content === 'string' ? m.content : '';
      const isError = ERROR_PREFIX_RE.test(content);
      if (EDIT_TOOLS.has(name) && !isError) didSuccessfulEdit = true;
      if (name === 'shell' || name === 'auto_fix' || name === 'code_run') {
        didRunShell = true;
        if (TEST_RUNNER_RE.test(content) || TEST_RESULT_RE.test(content)) didRunTests = true;
      }
    }
  }
  return { didSuccessfulEdit, didRunTests, didRunShell };
}

/**
 * Returns a corrective observation when the final message makes a claim the session
 * can't back up, or null when the claims are supported (or there are none). Pure.
 * Conservative by design — only flags CLEAR contradictions to avoid nagging.
 */
export function checkCompletionClaims(
  claims: CompletionClaims,
  evidence: SessionEvidence,
): string | null {
  const problems: string[] = [];

  if (claims.claimsTestsPass && !evidence.didRunTests) {
    problems.push(
      'You stated the tests pass, but no test command ran this session. Either run the ' +
      'test suite now and show the actual output, or remove the claim that tests pass.',
    );
  }
  if (claims.claimsFixOrChange && !evidence.didSuccessfulEdit) {
    problems.push(
      'You stated you fixed/changed/created something, but no file edit succeeded this ' +
      'session. Either make the actual edit now, or correct your summary to say what you ' +
      'really did (e.g. only analyzed, or were blocked).',
    );
  }

  if (problems.length === 0) return null;
  return (
    '[COMPLETION_GATE] Before finishing, your claims must match what actually happened:\n' +
    problems.map(p => '  • ' + p).join('\n') +
    '\nDo the work or revise the claim — do not report success you cannot demonstrate.'
  );
}

/** Convenience: one call from text + messages → corrective message or null. */
export function evaluateCompletion(finalText: string, messages: MsgLike[]): string | null {
  const claims = extractCompletionClaims(finalText);
  if (!claims.claimsFixOrChange && !claims.claimsTestsPass) return null; // nothing asserted
  return checkCompletionClaims(claims, gatherSessionEvidence(messages));
}
