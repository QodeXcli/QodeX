/**
 * Auto-evaluation driver — `qodex skill eval <name>` (on-demand, real execution).
 *
 * Tests whether a captured skill actually produces working code, not just whether a
 * judge *likes* it. The skill's own (independent) judge model is asked to PRODUCE the
 * concrete files the skill prescribes for its original task; those files are written
 * into a throwaway **git worktree** (a clean checkout of HEAD, so the real working tree
 * is never touched) and run through QodeX's REAL objective verifier (`verifyTouchedFiles`
 * → tsc/ruff/…). The outcome (pass/fail/inconclusive) is written into the skill's
 * `## Auto-evaluation` section. Bounded: one model call, content-hash cached, worktree
 * always cleaned up. The pure formatting/cache logic lives in eval-record.ts.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import spawn from 'cross-spawn';
import { loadConfig } from '../../config/loader.js';
import { ModelRouter } from '../../llm/router.js';
import { verifyTouchedFiles } from '../../agent/verification.js';
import { logger } from '../../utils/logger.js';
import { type EvalResult, extractOriginalPrompt, deriveStatus, shouldSkipEval } from './eval-record.js';

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const c = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout?.on('data', d => { out += String(d); });
    c.stderr?.on('data', d => { out += String(d); });
    c.on('error', () => resolve({ code: 1, out }));
    c.on('close', code => resolve({ code: code ?? 1, out }));
  });
}

async function drain(stream: AsyncGenerator<any>): Promise<string> {
  let t = '';
  for await (const ev of stream) if (ev?.type === 'text_delta') t += ev.delta ?? '';
  return t;
}

export interface EvalOptions {
  noCache?: boolean;
  cacheTtlMs?: number;
  onProgress?: (m: string) => void;
}

/**
 * Evaluate one skill (by its raw SKILL.md text). Returns the result and the model used,
 * or `{ skipped, reason }` when the cache says it's fresh. Never throws into the caller —
 * a failure is reported as status 'error'.
 */
export async function evalSkillMd(
  cwd: string,
  skillMd: string,
  opts: EvalOptions = {},
): Promise<{ result?: EvalResult; skipped?: boolean; reason?: string }> {
  const log = opts.onProgress ?? (() => {});

  // Cache: skip if unchanged + within TTL.
  if (!opts.noCache) {
    const ttl = opts.cacheTtlMs ?? 24 * 3600_000;
    const c = shouldSkipEval(skillMd, ttl, Date.now());
    if (c.skip) return { skipped: true, reason: c.reason };
  }

  const prompt = extractOriginalPrompt(skillMd);
  if (!prompt) return { result: errResult('?', 'no "## Original request" section to replay') };

  // Must be a git repo (we replay in a worktree off HEAD).
  if ((await git(['rev-parse', '--is-inside-work-tree'], cwd)).out.trim() !== 'true') {
    return { result: errResult('?', 'not a git repository — eval needs a worktree off HEAD') };
  }

  // Load env + config + router (this command runs outside the main bootstrap).
  try { const { loadEnvFileIntoProcess } = await import('../../setup/env-writer.js'); await loadEnvFileIntoProcess(); } catch { /* best-effort */ }
  const config = await loadConfig(cwd);
  const router = new ModelRouter(config);
  await router.initialize();
  let route;
  try {
    const explicit = String((config as any).learning?.judgeModel ?? '').trim();
    route = router.route('reflection', 2000, explicit ? { explicitModel: explicit } : {});
  } catch (e: any) {
    return { result: errResult('?', `no eval model available: ${e?.message}`) };
  }
  const model = route.model;

  // Ask the model to PRODUCE the files the skill prescribes for its task. We use a
  // SENTINEL-delimited format rather than JSON: file contents are code (newlines, quotes,
  // backslashes) and stuffing that into strict JSON routinely breaks parsing on local
  // models. The delimiters carry no escaping burden, so code round-trips verbatim.
  log(`Replaying "${prompt.slice(0, 50)}…" with ${model} …`);
  const system =
    'You are executing a reusable skill on a FRESH checkout to TEST it. Given the SKILL and ' +
    'its ORIGINAL TASK, output ONLY the concrete file changes the skill prescribes — complete, ' +
    'compilable file contents, not snippets. If the task cannot be done without the original ' +
    'project\'s specific files, output nothing.\n\n' +
    'Output each file EXACTLY in this format, and nothing else:\n' +
    '===FILE: relative/path/here===\n<full file content>\n===ENDFILE===';
  const user = `## Skill\n\`\`\`\n${skillMd.slice(0, 8000)}\n\`\`\`\n\n## Original task\n${prompt}\n\nProduce the file(s) now.`;

  let files: Array<{ path: string; content: string }> = [];
  try {
    const text = await drain(route.provider.complete({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0 } as any));
    files = parseSentinelFiles(text);
  } catch (e: any) {
    return { result: errResult(model, `model call failed: ${e?.message}`) };
  }

  // Clean room: a detached worktree off HEAD. node_modules is symlinked so JS/TS checks work.
  const wt = path.join(os.tmpdir(), `qodex-eval-${process.pid}-${Math.abs(hash(skillMd))}`);
  await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  const add = await git(['worktree', 'add', '--detach', wt, 'HEAD'], cwd);
  if (add.code !== 0) return { result: errResult(model, `git worktree add failed: ${add.out.trim().slice(0, 160)}`) };

  try {
    const nm = path.join(cwd, 'node_modules');
    if (await exists(nm)) await fs.symlink(nm, path.join(wt, 'node_modules'), 'dir').catch(() => {});

    const written: string[] = [];
    for (const f of files) {
      const dest = path.join(wt, f.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content, 'utf-8');
      written.push(f.path);
    }

    const verify = await verifyTouchedFiles({ cwd: wt, touched: written });
    const status = deriveStatus(written.length, verify.ran, verify.errorCount);
    log(`  → ${status} (${written.length} file(s), ${verify.ran ? `${verify.errorCount} new error(s) via ${verify.checker ?? 'checker'}` : 'no checker for this language'})`);
    return {
      result: {
        status,
        checker: verify.ran ? verify.checker : undefined,
        errorCount: verify.errorCount,
        filesChanged: written.length,
        model,
        at: new Date().toISOString(),
        note: status === 'fail'
          ? verify.diagnostics.slice(0, 3).map(d => d.message).join(' · ')
          : status === 'inconclusive' ? (written.length === 0 ? 'skill produced no files for this task' : 'no objective checker for this language') : undefined,
      },
    };
  } finally {
    await git(['worktree', 'remove', '--force', wt], cwd);
    await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Parse sentinel-delimited files from a model response. Tolerant of a stray closing
 * fence and trailing whitespace; rejects absolute or parent-escaping paths (sandbox).
 * Exported for unit testing.
 */
export function parseSentinelFiles(text: string): Array<{ path: string; content: string }> {
  const re = /===FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n===ENDFILE===/g;
  const out: Array<{ path: string; content: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = (m[1] ?? '').trim();
    let content = m[2] ?? '';
    content = content.replace(/\n?```\s*$/, ''); // strip a trailing fence the model may add
    if (!p || path.isAbsolute(p) || p.split('/').includes('..')) continue;
    out.push({ path: p, content });
  }
  return out;
}

function errResult(model: string, note: string): EvalResult {
  return { status: 'error', errorCount: 0, filesChanged: 0, model, at: new Date().toISOString(), note };
}
function hash(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
async function exists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }
