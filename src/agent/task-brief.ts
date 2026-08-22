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

const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.\w{1,8}\b|\b[\w.-]+\.\w{1,8}\b/g;

/** Same verb table the loop used inline — one source so tests and the prompt cannot drift. */
export function classifyPromptClass(prompt: string): PromptTaskClass {
  // Paths like ui.tsx / button.tsx must not flip the class to frontend.
  const text = String(prompt ?? '').toLowerCase().replace(PATH_RE, ' ');
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
  for (const m of src.matchAll(PATH_RE)) {
    const h = m[0]!;
    const i = m.index ?? 0;
    if (i >= 3 && /:\/\//.test(src.slice(Math.max(0, i - 8), i))) continue;
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
    if (out.length >= 8) break;
  }
  return out;
}

const CONSTRAINT_RE =
  /(?:don't|do not|never|must not|without|only|بدون|نکن|نباید|فقط)[^.!?\n،؛]{0,80}/gi;

export function extractConstraints(prompt: string): string[] {
  const hits = String(prompt ?? '').match(CONSTRAINT_RE) ?? [];
  return hits.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length >= 8).slice(0, 5);
}

export function inferTaskEffort(prompt: string, taskClass: PromptTaskClass, paths: string[]): TaskEffort {
  if (isTrivialMessage(prompt)) return 'low';
  const p = prompt.toLowerCase();
  if (looksLikeBuildTask(prompt)) return 'high';
  if (paths.length >= 3) return 'high';
  if (/\b(from scratch|architecture|security|production|carefully|root cause|race|deadlock|migrate)\b/.test(p)
    || /(از صفر|معماری|امنیت|با دقت|علت اصلی)/.test(p)) return 'high';
  if (taskClass === 'debug' && /\b(crash|exception|hang|regression|race)\b/.test(p)) return 'high';
  if (taskClass === 'analysis' || taskClass === 'review') return 'high';
  if (prompt.length < 80 && paths.length <= 1 && /\b(typo|rename|comment|jsdoc)\b/.test(p)) return 'low';
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
