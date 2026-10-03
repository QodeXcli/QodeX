/**
 * TUI approval-mode UX (src/cli/approval-ui.ts): what Shift+Tab may answer for the user
 * when it switches the mode while a prompt is on screen. The safety rules: never a
 * Sentinel prompt (critical or not), never the auto policy's "ask", never a question,
 * an unknown prompt or another lane's prompt, and never a standing "always" grant.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  autoAnswerForMode, oneShotAffirmative, modeBadge, autoModeBannerOnce, resetAutoModeBannerForTests,
  AUTO_MODE_BANNER, autoAnsweredLine,
} from '../src/cli/approval-ui.js';
import { PermissionEngine, setApprovalMode, type PermissionDecision } from '../src/security/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { SENTINEL_PROMPT_TITLE } from '../src/sentinel/guard.js';

const SHELL = ['yes', 'no', 'always yes'];
const EDIT = ['accept', 'always yes', 'edit', 'continue', 'reject'];
const allow = (): PermissionDecision => 'allow';
const ask = (): PermissionDecision => 'ask';

const criticalPrompt = [
  SENTINEL_PROMPT_TITLE,
  'Action: click "Pay now"',
  'Category: payment · risk: critical',
  'Critical actions always need your explicit answer (/auto and --yes do not apply).',
  'Allow this action?',
].join('\n');

afterEach(() => { setApprovalMode('manual'); });

describe('autoAnswerForMode', () => {
  const shellPrompt = { prompt: 'Run: npm test', options: SHELL, meta: { kind: 'permission' as const, tool: 'shell', operation: 'npm test' }, lane: 'tui', origin: 'tui' };

  it('answers a permission prompt the new mode allows — one-shot "yes", never "always yes"', () => {
    const seen: unknown[] = [];
    const a = autoAnswerForMode(shellPrompt, 'auto', req => { seen.push(req); return 'allow'; });
    expect(a).toBe('yes');
    expect(seen).toEqual([{ tool: 'shell', operation: 'npm test' }]);
    expect(autoAnswerForMode({ ...shellPrompt, options: ['always yes', 'no'] }, 'auto', allow)).toBeNull();
  });

  it('leaves the auto policy\'s "ask" (destructive outside the project) for the human', () => {
    expect(autoAnswerForMode(shellPrompt, 'auto', ask)).toBeNull();
    expect(autoAnswerForMode(shellPrompt, 'auto', () => 'deny')).toBeNull();
    expect(autoAnswerForMode(shellPrompt, 'auto', () => { throw new Error('boom'); })).toBeNull();
  });

  it('manual never answers anything', () => {
    expect(autoAnswerForMode(shellPrompt, 'manual', allow)).toBeNull();
  });

  it('NEVER answers a Sentinel prompt — critical or not, whatever meta claims', () => {
    expect(autoAnswerForMode({ prompt: criticalPrompt, options: ['yes', 'no'] }, 'auto', allow)).toBeNull();
    // A Sentinel prompt that (wrongly or maliciously) carries permission meta.
    expect(autoAnswerForMode({ ...shellPrompt, prompt: criticalPrompt }, 'auto', allow)).toBeNull();
    expect(autoAnswerForMode({ ...shellPrompt, meta: { kind: 'sentinel' } }, 'auto', allow)).toBeNull();
    const nonCritical = `${SENTINEL_PROMPT_TITLE}\nCategory: delete · risk: high\n"always" allows delete actions on example.com for the rest of this session.\nAllow this action?`;
    expect(autoAnswerForMode({ prompt: nonCritical, options: ['yes', 'no', 'always'], meta: { kind: 'permission', tool: 'browser_click', operation: 'sentinel:delete example.com browser_click' } }, 'auto', allow)).toBeNull();
  });

  it('leaves questions, unknown prompts and other lanes for the human', () => {
    expect(autoAnswerForMode({ prompt: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], meta: { kind: 'question' } }, 'auto', allow)).toBeNull();
    expect(autoAnswerForMode({ prompt: 'Run MCP tool x?', options: ['yes', 'no'] }, 'auto', allow)).toBeNull();
    expect(autoAnswerForMode({ ...shellPrompt, lane: 'bot:telegram:1', origin: 'telegram:1' }, 'auto', allow)).toBeNull();
    expect(autoAnswerForMode({ ...shellPrompt, meta: { kind: 'permission', tool: 'shell' } }, 'auto', allow)).toBeNull();
  });

  it('a pending file-edit diff is accepted when switching to edits (the engine allows edit tools there)', () => {
    const editPrompt = { prompt: 'Overwrite src/a.ts?', options: EDIT, meta: { kind: 'permission' as const, tool: 'write_file', operation: 'src/a.ts' }, lane: 'tui', origin: 'tui' };
    const engine = new PermissionEngine(DEFAULT_CONFIG);
    setApprovalMode('edits');
    expect(autoAnswerForMode(editPrompt, 'edits', req => engine.evaluate(req))).toBe('accept');
    // …but a shell prompt is not an edit: edits mode leaves it.
    expect(autoAnswerForMode({ ...shellPrompt, meta: { kind: 'permission', tool: 'shell', operation: 'make deploy-local' } }, 'edits', req => engine.evaluate(req))).toBeNull();
  });

  it('with the real engine in auto: ordinary work is answered, a force-push is not', () => {
    const engine = new PermissionEngine(DEFAULT_CONFIG);
    setApprovalMode('auto');
    const ev = (req: { tool: string; operation: string }) => engine.evaluate(req);
    expect(autoAnswerForMode({ ...shellPrompt, meta: { kind: 'permission', tool: 'shell', operation: 'npm install lodash' } }, 'auto', ev)).toBe('yes');
    expect(autoAnswerForMode({ ...shellPrompt, meta: { kind: 'permission', tool: 'shell', operation: 'git push --force origin main' } }, 'auto', ev)).toBeNull();
  });
});

describe('helpers', () => {
  it('oneShotAffirmative picks accept/yes, never an "always" option', () => {
    expect(oneShotAffirmative(EDIT)).toBe('accept');
    expect(oneShotAffirmative(SHELL)).toBe('yes');
    expect(oneShotAffirmative(['always', 'no'])).toBeNull();
    expect(oneShotAffirmative(['Postgres', 'SQLite'])).toBeNull();
  });

  it('mode badges are distinct and auto stands out', () => {
    const labels = (['manual', 'edits', 'auto'] as const).map(m => modeBadge(m).label);
    expect(new Set(labels).size).toBe(3);
    expect(modeBadge('auto')).toMatchObject({ bold: true });
    expect(modeBadge('auto').label).toContain('auto');
  });

  it('the auto banner explains what still asks, once per process', () => {
    resetAutoModeBannerForTests();
    expect(autoModeBannerOnce()).toBe(AUTO_MODE_BANNER);
    expect(autoModeBannerOnce()).toBeNull();
    for (const w of ['purchases', 'payments', 'passwords', 'sending messages', 'outside the project', 'Deny rules']) {
      expect(AUTO_MODE_BANNER).toContain(w);
    }
  });

  it('the answered-for-you line names the operation', () => {
    expect(autoAnsweredLine({ prompt: 'Run: npm test', options: SHELL, meta: { kind: 'permission', tool: 'shell', operation: 'npm test' } }, 'yes', 'auto'))
      .toBe('Answered "yes" for you — auto mode allows: npm test');
  });
});
