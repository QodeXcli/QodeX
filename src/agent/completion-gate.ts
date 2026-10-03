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

// ── Real-world action evidence (browser / desktop / workflows / missions) ──────────
// "I added it to the cart" / "سفارش رو ثبت کردم" are backed by a successful browser
// action, not by a file edit. Without this the gate bounced every honest web/desktop
// success once ("no file edit succeeded this session").

/** Exact tools whose success is evidence of a performed real-world action. */
const ACTION_TOOLS = new Set(['workflow_run', 'mission_start', 'browser_fill_secret', 'browser_agent', 'computer_use_agent']);
/** browser_* tools that only OBSERVE (their success is not evidence of an action). */
const BROWSER_OBSERVE_ONLY = new Set([
  'browser_snapshot', 'browser_screenshot', 'browser_get_text', 'browser_extract', 'browser_console',
  'browser_network', 'browser_status', 'browser_downloads', 'browser_wait_for', 'browser_close',
]);
/** computer_use_* tools that only observe. Everything else in the family mutates. */
const DESKTOP_OBSERVE_ONLY = new Set([
  'computer_use_screenshot', 'computer_use_screen_info', 'computer_use_active_window',
  'computer_use_list_windows', 'computer_use_locate',
]);
/** Error codes that are actually success markers. */
const SUCCESS_CODES = new Set(['SUBAGENT_DONE', 'OK', 'DONE', 'SUCCESS']);

/** True when `name` (with its parsed args, when known) is a real-world ACTION tool. PURE. */
export function isActionTool(name: string, args?: Record<string, unknown> | null): boolean {
  if (!name) return false;
  if (ACTION_TOOLS.has(name)) return true;
  if (name.startsWith('browser_')) {
    if (BROWSER_OBSERVE_ONLY.has(name)) return false;
    const action = typeof args?.action === 'string' ? args.action : '';
    if (name === 'browser_tabs') return action !== '' && action !== 'list';
    if (name === 'browser_dialog') return action === 'accept' || action === 'dismiss';
    return true;
  }
  if (name.startsWith('computer_use_')) {
    if (DESKTOP_OBSERVE_ONLY.has(name)) return false;
    if (name === 'computer_use_clipboard') return args?.action === 'set';
    return true;
  }
  return false;
}

/**
 * Does a tool-result text look like a failure? Looks at the first few lines so a
 * Sentinel `<untrusted_content>` fence (or its one-line header) in front of the result
 * doesn't hide a `[BROWSER_ERROR]`-style code. PURE.
 */
export function looksLikeErrorResult(content: string): boolean {
  if (typeof content !== 'string' || !content.trim()) return false;
  const head = content.slice(0, 600).split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4);
  for (const line of head) {
    const m = /^\[([A-Z][A-Z0-9_]*)\]/.exec(line);
    if (m && !SUCCESS_CODES.has(m[1]!)) return true;
  }
  return false;
}

export interface CompletionClaims {
  claimsFixOrChange: boolean; // "I fixed / resolved / updated / created …"
  claimsTestsPass: boolean;   // "tests pass / all green …"
  /** The subset of fix/change claims that only a CODE edit can back ("I fixed the bug",
   *  "I refactored", "اصلاح کردم"). A browser click is no evidence for these — otherwise a
   *  frontend session that merely opened the page could claim "I fixed the layout". */
  claimsCodeFix?: boolean;
  /** "I placed the order / submitted the form / sent the message / booked …" (web/desktop). */
  claimsAction: boolean;
}

export interface SessionEvidence {
  didSuccessfulEdit: boolean; // an edit/write tool returned non-error
  didRunTests: boolean;       // a test runner was invoked OR test output appeared
  didRunShell: boolean;       // any shell command executed
  /** A browser/desktop action, workflow_run, mission_start or vault fill succeeded. */
  didSuccessfulAction: boolean;
}

/** Minimal structural view of a message (works for real Message or test mocks). */
export interface MsgLike {
  role: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
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

/** Fix/change claims that only a code edit can back (subset of FIX_CLAIM_KEYWORDS). The
 *  generic ones — added / updated / created / changed — can also be done in a browser. */
const CODE_FIX_CLAIM_KEYWORDS = [
  'i fixed', "i've fixed", 'fixed the', 'resolved the', 'i resolved', 'i implemented', 'i wrote',
  'i refactored', 'i corrected', 'the fix', 'has been fixed', 'now works', 'should now work', 'is now fixed',
  'اصلاح کردم', 'درست کردم', 'رفع کردم', 'رفع شد', 'حل کردم', 'حل شد', 'نوشتم', 'پیاده کردم',
  'پیاده‌سازی کردم', 'تعمیر کردم', 'برطرف کردم', 'برطرف شد', 'درستش کردم', 'اصلاحش کردم',
];

/** Claims of a performed real-world action (web/desktop). Specific phrases only — the
 *  generic "I added/updated/created" already live in FIX_CLAIM_KEYWORDS. */
const ACTION_CLAIM_KEYWORDS = [
  'i placed', "i've placed", 'i ordered', "i've ordered", 'i submitted', "i've submitted",
  'i booked', "i've booked", 'i reserved', "i've reserved", 'i purchased', "i've purchased", 'i bought',
  'i sent', "i've sent", 'i posted', "i've posted", 'i published', "i've published",
  'i filled', "i've filled", 'i logged in', "i've logged in", 'i signed up', "i've signed up",
  'i registered', 'i uploaded', "i've uploaded", 'i checked out', 'i completed the purchase',
  'added to the cart', 'added it to the cart', 'added to cart', 'added to your cart',
  'order has been placed', 'order was placed', 'has been submitted', 'was submitted successfully',
  'message has been sent', 'has been booked', 'is now booked', 'payment was successful',
  // Persian
  'ثبت کردم', 'سفارش دادم', 'سفارش رو ثبت', 'سفارش را ثبت', 'خرید کردم', 'خریدم',
  'ارسال کردم', 'فرستادم', 'پر کردم', 'رزرو کردم', 'وارد شدم', 'لاگین کردم',
  'ثبت‌نام کردم', 'ثبت نام کردم', 'به سبد خرید اضافه', 'پست کردم', 'منتشر کردم',
  'آپلود کردم', 'پرداخت کردم', 'پرداخت شد', 'سفارش ثبت شد',
];

export function extractCompletionClaims(finalText: string): CompletionClaims {
  const t = (finalText || '').toLowerCase();
  return {
    claimsFixOrChange: FIX_CLAIM_KEYWORDS.some(k => t.includes(k)),
    claimsTestsPass: TEST_CLAIM_KEYWORDS.some(k => t.includes(k)),
    claimsCodeFix: CODE_FIX_CLAIM_KEYWORDS.some(k => t.includes(k)),
    claimsAction: ACTION_CLAIM_KEYWORDS.some(k => t.includes(k)),
  };
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

export function gatherSessionEvidence(messages: MsgLike[]): SessionEvidence {
  let didSuccessfulEdit = false;
  let didRunTests = false;
  let didRunShell = false;
  let didSuccessfulAction = false;
  // tool_call_id → parsed args, so a result can be judged with the call's arguments
  // (browser_tabs list vs new, computer_use_clipboard get vs set).
  const argsById = new Map<string, Record<string, unknown> | null>();

  for (const m of messages) {
    // Attempted tool calls (assistant side) — read shell command args for test runners.
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc.function?.name ?? '';
        const args = tc.function?.arguments ?? '';
        if (tc.id) argsById.set(tc.id, parseArgs(args));
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
      if (!didSuccessfulAction) {
        const args = m.tool_call_id ? argsById.get(m.tool_call_id) ?? null : null;
        if (isActionTool(name, args) && !looksLikeErrorResult(content)) didSuccessfulAction = true;
      }
    }
  }
  return { didSuccessfulEdit, didRunTests, didRunShell, didSuccessfulAction };
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
  // Older callers (and tests) may pass evidence/claims without the newer fields.
  const didAction = evidence.didSuccessfulAction === true;

  if (claims.claimsTestsPass && !evidence.didRunTests) {
    problems.push(
      'You stated the tests pass, but no test command ran this session. Either run the ' +
      'test suite now and show the actual output, or remove the claim that tests pass.',
    );
  }
  // A change can be made through a file edit OR a real-world action ("I added it to the
  // cart", "I updated your profile" via the browser) — except code-fix claims, which only
  // an edit can back.
  const changeBackedByAction = didAction && claims.claimsCodeFix !== true;
  if (claims.claimsFixOrChange && !evidence.didSuccessfulEdit && !changeBackedByAction) {
    problems.push(
      'You stated you fixed/changed/created something, but no file edit succeeded this ' +
      'session. Either make the actual edit now, or correct your summary to say what you ' +
      'really did (e.g. only analyzed, or were blocked).',
    );
  }
  // Conservative: only flag an action claim when NOTHING consequential happened at all
  // (no browser/desktop action, no edit, no shell command).
  if (claims.claimsAction === true && !didAction && !evidence.didSuccessfulEdit && !evidence.didRunShell) {
    problems.push(
      'You stated you completed an action (placed an order, submitted a form, sent a message, ' +
      'booked, logged in, …), but no browser/desktop action succeeded this session. Either do it ' +
      'now with the browser_*/computer_use_* tools and confirm it on the page, or correct your ' +
      'summary to say what really happened (e.g. you were blocked or the user declined).',
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
  if (!claims.claimsFixOrChange && !claims.claimsTestsPass && !claims.claimsAction) return null; // nothing asserted
  return checkCompletionClaims(claims, gatherSessionEvidence(messages));
}
