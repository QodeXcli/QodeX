/**
 * Compile a short, model-facing brief from the user's raw task.
 *
 * No extra LLM call. The point is to turn a fuzzy request into an explicit
 * kind / effort / file list / constraints so the worker does not wander.
 * Effort auto-raises `reasoning_effort` to high only when the task is hard —
 * local models must not pay a thinking tax on "fix the typo".
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { isTrivialMessage } from './trivial-message.js';
import { looksLikeBuildTask } from './preflight-gate.js';

export type PromptTaskClass =
  | 'refactor' | 'debug' | 'feature' | 'review' | 'explain'
  | 'frontend' | 'backend' | 'analysis' | 'general';

export type TaskEffort = 'low' | 'medium' | 'high';

export interface TaskBrief {
  taskClass: PromptTaskClass;
  effort: TaskEffort;
  paths: string[];
  constraints: string[];
}

/**
 * Paths the user named. Slash-paths just need a letter-starting extension so
 * `src/foo.ts` hits and `docs/v2.7.0` does not. Bare names use a code/config
 * allow-list — otherwise `v2.7.0`, `e.g.`, `20.11.0`, `www.example.com` steal
 * named-file slots and can bump effort to high (paths.length >= 3).
 */
const SLASH_PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w]{0,7}\b/g;
const BARE_EXT =
  'tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|kts|cs|cpp|cc|cxx|hpp|hxx|c|h|mm?|swift|php|sh|bash|zsh|jsonc?|ya?ml|toml|mdx?|html?|css|scss|less|vue|svelte|astro|sql|graphql|gql|proto|xml|env|ini|cfg|conf|lock|txt|csv|svg|zig|lua|dart|exs?|erl|hs|clj|scala|tf|hcl|nix|wasm|ps1|bat|r';
const BARE_FILE_RE = new RegExp(String.raw`\b[A-Za-z][\w.-]*\.(?:${BARE_EXT})\b`, 'gi');

function stripMentionedPaths(s: string): string {
  return s.replace(SLASH_PATH_RE, ' ').replace(BARE_FILE_RE, ' ');
}

function looksLikeUrlPrefix(src: string, index: number): boolean {
  const pre = src.slice(Math.max(0, index - 8), index);
  return /:\/\//.test(pre) || /www\.$/i.test(pre);
}

/** Same verb table the loop used inline — one source so tests and the prompt cannot drift. */
export function classifyPromptClass(prompt: string): PromptTaskClass {
  // Paths like ui.tsx / button.tsx must not flip the class to frontend.
  const text = stripMentionedPaths(String(prompt ?? '').toLowerCase());
  if (/\b(django|drf|django ?rest|serializer|viewset|queryset|orm|migration|makemigrations|models?\.py|celery|wsgi|asgi|manage\.py|backend|back ?end|api ?endpoint|rest ?api)\b/.test(text)
    || /(جنگو|بک‌?اند|بک ?اند|بکند|سمت ?سرور|پایگاه ?داده|دیتابیس)/.test(text)) {
    return 'backend';
  }
  if (/\b(design|redesign|ui|ux|frontend|landing(?: ?page)?|hero(?: section)?|component|style|theme|layout|animation|three\.?js|react three|r3f|page|button|navbar|header|footer|card|modal|dropdown|form ?design|color|palette|tailwind|shadcn|figma|wireframe|prototype|mockup|polish|aesthetic|beautiful|elegant|modern|minimalist|gradient|glassmorphism|neumorphism|skeuomorphic|3d|scene|webgl|shader|seo|json-?ld|structured ?data|schema\.?org|rich ?results|open ?graph|sitemap)\b/.test(text)
    || /(دیزاین|طراحی|زیبا|فرانت|قشنگ|مدرن|گرادیان|ظاهر|رابط ?کاربری|سایت|وب ?سایت)/.test(text)) {
    return 'frontend';
  }
  if (/\b(refactor|restructure|clean ?up|simplify|extract|inline|rename|move|consolidate|deduplicate|untangle)\b/.test(text)) return 'refactor';
  if (/\b(debug|fix|error|exception|crash|broken|bug|broke|stuck|hang|throwing|undefined|null|fail|regression|نمی‌?کار|نمیکار|خراب|باگ|اشکال|درست(?: نمی| نمی))\b/.test(text)) return 'debug';
  if (/\b(review|critique|audit|inspect|code ?review|smell|improve|quality|بررسی)\b/.test(text)) return 'review';
  if (/\b(explain|describe|what does|how does|walk through|understand|چطور|چگونه|توضیح)\b/.test(text)) return 'explain';
  if (/\b(trade-?offs?|business ?plan|pros and cons|cost[- ]benefit|swot|feasibility|go-to-market|value proposition|market analysis|competitive analysis|monetiz|decision matrix|which (?:option |one )?(?:is )?better|compare\b[\s\S]*\b(?:vs|versus)\b|evaluate (?:the )?options|weigh (?:the )?(?:options|pros)|should (?:i|we) (?:use|choose|pick|go with)|strategy|analy[sz]e|analysis)\b/.test(text)
    || /(تحلیل|بیزینس ?پلن|طرح ?کسب|کسب ?و ?کار|استراتژی|مقایسه|مزایا و معایب|سود و زیان|گزینه|ارزیابی|امکان ?سنجی|تصمیم|بازار)/.test(text)) {
    return 'analysis';
  }
  if (/\b(add|build|implement|create|new feature|develop|integrate|بساز|اضافه|پیاده ?سازی|ایجاد)\b/.test(text)) return 'feature';
  return 'general';
}

export function extractMentionedPaths(prompt: string): string[] {
  const src = String(prompt ?? '');
  const out: string[] = [];
  const seen = new Set<string>();
  const spans: [number, number][] = [];

  const consider = (h: string, i: number): void => {
    const span: [number, number] = [i, i + h.length];
    // Record URL spans too so a later bare `foo.ts` inside https://…/foo.ts is dropped.
    if (looksLikeUrlPrefix(src, i)) {
      spans.push(span);
      return;
    }
    if (out.length >= 8) return;
    if (seen.has(h)) return;
    seen.add(h);
    out.push(h);
    spans.push(span);
  };

  for (const m of src.matchAll(new RegExp(SLASH_PATH_RE.source, SLASH_PATH_RE.flags))) {
    consider(m[0]!, m.index ?? 0);
  }
  for (const m of src.matchAll(new RegExp(BARE_FILE_RE.source, BARE_FILE_RE.flags))) {
    const h = m[0]!;
    const i = m.index ?? 0;
    const j = i + h.length;
    if (spans.some(([a, b]) => i >= a && j <= b)) continue;
    consider(h, i);
  }
  return out;
}

// `only` / `without` as bare starters match prose ("the only output is ISO",
// "without tests this will break") and then get injected as fake constraints.
const CONSTRAINT_RE =
  /(?:don't|do not|never|must not|بدون|نکن|نباید|فقط)[^.!?\n،؛]{0,80}/gi;
const ONLY_CONSTRAINT_RE =
  /\bonly\s+(?:this|these|the named|change|edit|touch|modify|update|write)[^.!?\n،؛]{0,80}/gi;
const WITHOUT_CONSTRAINT_RE =
  /\bwithout\s+(?:chang(?:e|ing)|modif(?:y|ying)|touch(?:ing)?|edit(?:ing)?|alter(?:ing)?|updat(?:e|ing)|add(?:ing)?|remov(?:e|ing)|delet(?:e|ing)|creat(?:e|ing)|install(?:ing)?)[^.!?\n،؛]{0,80}/gi;

export function extractConstraints(prompt: string): string[] {
  const src = String(prompt ?? '');
  const hits = [
    ...(src.match(CONSTRAINT_RE) ?? []),
    ...(src.match(ONLY_CONSTRAINT_RE) ?? []),
    ...(src.match(WITHOUT_CONSTRAINT_RE) ?? []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hits) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (s.length < 8 || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

export function inferTaskEffort(prompt: string, taskClass: PromptTaskClass, paths: string[]): TaskEffort {
  if (isTrivialMessage(prompt)) return 'low';
  const p = prompt.toLowerCase();
  // Tiny edits before the build-task heuristic — "fix a typo in the frontend"
  // contains the strong signal `frontend` and used to raise effort to high.
  if (prompt.length < 80 && paths.length <= 1 && /\b(typo|rename|comment|jsdoc)\b/.test(p)) return 'low';
  if (looksLikeBuildTask(prompt)) return 'high';
  if (paths.length >= 3) return 'high';
  if (/\b(from scratch|architecture|security|production|carefully|root cause|race|deadlock|migrate)\b/.test(p)
    || /(از صفر|معماری|امنیت|با دقت|علت اصلی)/.test(p)) return 'high';
  if (taskClass === 'debug' && /\b(crash|exception|hang|regression|race)\b/.test(p)) return 'high';
  if (taskClass === 'analysis' || taskClass === 'review') return 'high';
  if (taskClass === 'explain' && prompt.length < 160) return 'low';
  return 'medium';
}

export function compileTaskBrief(prompt: string): TaskBrief {
  const taskClass = classifyPromptClass(prompt);
  const paths = extractMentionedPaths(prompt);
  const constraints = extractConstraints(prompt);
  const effort = inferTaskEffort(prompt, taskClass, paths);
  return { taskClass, effort, paths, constraints };
}

/** Empty for greetings so we don't tax "hi". PURE. */
export function formatTaskBrief(brief: TaskBrief, prompt: string): string {
  if (isTrivialMessage(prompt)) return '';
  const lines = ['# This task', `- kind: ${brief.taskClass}`, `- effort: ${brief.effort}`];
  if (brief.paths.length) {
    lines.push(`- files named: ${brief.paths.join(', ')}`);
    lines.push('- read those paths with read_file first; do not ls/glob to discover them.');
  }
  if (brief.constraints.length) {
    lines.push('- constraints:');
    for (const c of brief.constraints) lines.push(`  - ${c}`);
  }
  lines.push('- stay on this request; do not expand scope.');
  if (brief.effort === 'high') {
    lines.push('- think through the approach before the first mutating tool; verify before claiming done.');
  }
  return lines.join('\n');
}

const NAMED_FILE_MAX = 3;
const NAMED_FILE_CHARS = 8_000;

function safeUnderCwd(cwd: string, rel: string): string | null {
  const root = path.resolve(cwd);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * Inject the bodies of user-named files so the first turn does not burn
 * tool rounds on ls/glob. Caps count and size. Best-effort. Skips missing/binary.
 */
export async function readNamedFileSnippets(cwd: string, paths: string[]): Promise<string> {
  if (!paths.length) return '';
  const chunks: string[] = [];
  for (const rel of paths.slice(0, NAMED_FILE_MAX)) {
    const abs = safeUnderCwd(cwd, rel);
    if (!abs) continue;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > 64_000) continue;
      const buf = await fs.readFile(abs);
      if (buf.includes(0)) continue;
      let body = buf.toString('utf8');
      if (body.length > NAMED_FILE_CHARS) body = body.slice(0, NAMED_FILE_CHARS) + '\n…';
      chunks.push(`### ${rel}\n\`\`\`\n${body.replace(/\n+$/, '')}\n\`\`\``);
    } catch { /* missing */ }
  }
  if (!chunks.length) return '';
  return `# Files the user named (on disk — do not ls for these)\n\n${chunks.join('\n\n')}`;
}
