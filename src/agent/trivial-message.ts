/**
 * Is this user message trivial chit-chat (a greeting, thanks, a yes/no) rather than a task that
 * needs the codebase? For these, running semantic retrieval over the repo and injecting files is
 * pure waste — it bloats the prompt (a plain "Hi" was costing ~15k tokens largely from retrieval +
 * context the model doesn't need to say "hello back"). Conservative: only returns true for short
 * messages that match a known greeting/ack pattern AND contain no code-ish signal (paths, code
 * punctuation, file extensions, attached dirs). Anything that looks like a real request → false.
 */

const GREETING_RE = new RegExp(
  '^(' +
  // English
  'hi|hello|hey|yo|sup|hiya|howdy|thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|' +
  'good morning|good evening|good night|gm|gn|bye|goodbye|cheers|np|no problem|' +
  // Persian
  'سلام|درود|سلام علیکم|مرسی|ممنون|مرسی داداش|تشکر|دمت گرم|اوکی|اوکیه|باشه|خوبه|عالیه|' +
  'صبح بخیر|شب بخیر|خداحافظ|خدافظ|بای|چطوری|چطوری داداش|خوبی' +
  ')[\\s!.،؟?]*$',
  'i',
);

// Signals that a message is actually a task, even if short — never treat these as trivial.
const CODEISH_RE = /[\/\\{}()<>;=]|\.\w{1,5}\b|\[Attached|```|@\w/;

export function isTrivialMessage(prompt: string): boolean {
  if (!prompt) return true; // empty → nothing to retrieve for
  const t = prompt.trim();
  if (t.length === 0) return true;
  if (t.length > 40) return false;          // long enough to plausibly be a task
  if (CODEISH_RE.test(t)) return false;     // has code/path/attachment signal
  return GREETING_RE.test(t);
}
