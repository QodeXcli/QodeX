/**
 * Pre-flight architecture gate — PURE helpers, kept out of loop.ts so they're unit-testable.
 *
 * The problem: local models (Qwen/DeepSeek) rush to emit tokens and will happily start
 * writing raw code on a complex task without architecting first — "factory settings."
 * The gate breaks that chain in the CORE loop, not just in skills: before the FIRST code
 * change on a build/refactor task, the model must produce a plan. It's a ONE-SHOT, SOFT
 * nudge (returns a corrective tool-result the model adapts to), complexity-gated so trivial
 * edits ("fix this typo") are never blocked, and it fires at most once per task so it can
 * never lock the agent or loop forever.
 */

// Strong signals: their presence alone implies a real build/architecture task.
const STRONG_SIGNALS = [
  'plugin', 'pipeline', 'ci/cd', 'ci cd', 'microservice', 'architecture', 'architect',
  'refactor', 'rewrite', 're-architect', 'migrate', 'migration', 'scaffold', 'boilerplate',
  'dashboard', 'application', 'full stack', 'full-stack', 'backend', 'frontend', 'front-end',
  'integrate', 'integration', 'from scratch', 'end-to-end', 'end to end', 'subsystem',
  // Persian
  'پلاگین', 'پایپ‌لاین', 'پایپلاین', 'ریفکتور', 'بازنویسی', 'معماری', 'سیستم',
  'اپلیکیشن', 'داشبورد', 'از صفر', 'راه‌اندازی', 'راه اندازی', 'یکپارچه', 'ماژول',
];

// Weak signals: need at least two (plus a non-trivial prompt) to imply a build task.
const WEAK_SIGNALS = [
  'build', 'create', 'implement', 'develop', 'set up', 'setup', 'add a ', 'write a ',
  'rest api', 'api endpoint', 'endpoint', 'crud', 'database schema', 'data model', 'authentication',
  'بساز', 'پیاده', 'توسعه', 'اضافه', 'بنویس', 'ایجاد', 'ای‌پی‌آی', 'اندپوینت',
];

// Imperative build verbs. Their presence means the user is ORDERING a build (not just asking
// about one), so an advisory phrasing can't apply.
const BUILD_IMPERATIVES = [
  'build', 'create', 'implement', 'refactor', 'rewrite', 'migrate', 'scaffold', 'develop',
  'set up', 'setup', 'add ', 'write ', 'make ', 'integrate',
  'بساز', 'بنویس', 'ایجاد کن', 'پیاده کن', 'پیاده‌سازی کن', 'ریفکتور', 'بازنویسی کن',
  'اضافه کن', 'راه‌اندازی کن', 'راه اندازی کن', 'طراحی کن', 'درست کن', 'یکپارچه کن',
];

// Phrases that mark a request for analysis / opinion / recommendation rather than a build order.
const ADVISORY_MARKERS = [
  'what do you think', 'what would you', 'should i', 'should we', 'do you think',
  'in your opinion', 'your opinion', 'what does it need', 'what architecture', 'how would you',
  'recommend', 'suggest', 'thoughts on', 'what are the', "what's wrong", 'what is wrong',
  // Persian
  'نظرت', 'به نظرت', 'پیشنهاد', 'نیاز داره', 'نیاز دارد', 'بهتره', 'به چه', 'چه معماری',
  'چی کار کنم', 'چطور بهتر', 'آیا', 'مشکل',
];

/**
 * Is the user ASKING for analysis/opinion/recommendation (e.g. "what architecture does this
 * need?", "what's wrong with X?") rather than ordering a build? Advisory questions should be
 * answered in chat — they must not trip the build/architecture plan gate or push the model into
 * writing an unsolicited DESIGN.md. A build imperative ("build…", "بساز") overrides this.
 */
export function looksLikeAdvisoryQuestion(prompt: string): boolean {
  if (!prompt) return false;
  const p = prompt.toLowerCase();
  if (BUILD_IMPERATIVES.some(v => p.includes(v))) return false;
  const isQuestion = /[?؟]/.test(prompt);
  const hasMarker = ADVISORY_MARKERS.some(m => p.includes(m));
  return isQuestion || hasMarker;
}

/**
 * Does this user request look like a build/refactor that deserves a plan first?
 * Conservative by design — biased toward NOT firing, since the gate is also guarded by
 * "only before an actual mutating tool call." False positives cost one planning turn, not a block.
 */
export function looksLikeBuildTask(prompt: string): boolean {
  if (!prompt) return false;
  // "What architecture does it need?" / "what's wrong with X?" is advisory — answer in chat,
  // don't gate it as a build even though it contains the word "architecture".
  if (looksLikeAdvisoryQuestion(prompt)) return false;
  const p = prompt.toLowerCase();
  if (STRONG_SIGNALS.some(s => p.includes(s))) return true;
  const weak = WEAK_SIGNALS.reduce((n, w) => n + (p.includes(w) ? 1 : 0), 0);
  return weak >= 2 && prompt.length > 120;
}

const PLAN_FILE_RE = /(^|[/\\])(plan|design|architecture|adr|rfc)[^/\\]*\.(md|markdown|txt)$/i;

/**
 * Is this tool call itself a planning action (so it satisfies the gate rather than tripping it)?
 * present_plan / todo_write, or writing a PLAN/DESIGN/ARCHITECTURE/ADR/RFC document.
 */
export function isPlanningToolCall(name: string, args: any): boolean {
  if (name === 'present_plan' || name === 'todo_write') return true;
  if (name === 'write_file' || name === 'create_file' || name === 'edit_text') {
    const path =
      typeof args?.path === 'string' ? args.path :
      typeof args?.file === 'string' ? args.file :
      typeof args?.filename === 'string' ? args.filename : '';
    return PLAN_FILE_RE.test(path);
  }
  return false;
}

export const PREFLIGHT_MESSAGE =
  '[ARCHITECTURE_GATE] This looks like a build/refactor task and no plan exists yet. ' +
  'Before the first code change, lay out the plan: the approach, the files/modules you will ' +
  'create or change, and the key design decisions — either written briefly in your reply, or by ' +
  'writing a short DESIGN.md / using todo_write. THEN implement. For a genuinely multi-domain ' +
  'task (frontend + backend + database), prefer decomposing it with `orchestrate` rather than ' +
  'writing everything linearly. ' +
  '(This fires at most once per task to keep the work architected, not rushed — it will NOT block you again this turn.)';
