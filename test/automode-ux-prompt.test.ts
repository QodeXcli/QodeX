/**
 * The system prompt's "Autonomous mode" section (src/llm/prompts/system.ts): present only
 * in auto mode, replaces the questions-inviting parts (permission flow, skill-install
 * question, strict-mode waits), and keeps every prompt variant inside the eval budgets
 * (src/eval/suites/harness.ts — the sub-agent prompt is the tightest, ~6.5k tokens).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildSystemPrompt, buildAutonomousSection, AUTONOMOUS_SECTION_TITLE, type SystemPromptContext } from '../src/llm/prompts/system.js';
import { CONTRADICTION_PAIRS, DEFAULT_BUDGETS, realProbes } from '../src/eval/suites/harness.js';
import { setApprovalMode, type ApprovalMode } from '../src/security/permissions.js';
import { setStrictMode } from '../src/safety/strict-mode.js';

afterEach(() => { setApprovalMode('manual'); setStrictMode(false); });

const P = realProbes();
const names = P.registeredToolNames();

function ctx(over: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    cwd: '/repo',
    mode: 'normal',
    modelFamily: 'claude',
    modelId: 'claude-sonnet-4-6',
    projectInfo: { languages: ['typescript'], testRunner: 'vitest' },
    knowledgeFacts: [],
    directoryTree: '',
    gitBranch: 'main',
    availableToolNames: names,
    ...over,
  };
}

const VARIANTS: Array<{ id: string; over: Partial<SystemPromptContext>; budget: number }> = [
  { id: 'normal-compressed', over: {}, budget: DEFAULT_BUDGETS.promptTokensCompressed },
  { id: 'normal-full', over: { modelFamily: 'qwen', modelId: 'qwen2.5-coder-7b' }, budget: DEFAULT_BUDGETS.promptTokensFull },
  { id: 'plan-compressed', over: { mode: 'plan' }, budget: DEFAULT_BUDGETS.promptTokensCompressed },
  { id: 'subagent-compressed', over: { mode: 'subagent' }, budget: DEFAULT_BUDGETS.promptTokensCompressed },
];

describe('Autonomous mode section', () => {
  it('is present only in auto mode (every variant)', () => {
    for (const v of VARIANTS) {
      for (const mode of ['manual', 'edits', 'auto'] as ApprovalMode[]) {
        const text = buildSystemPrompt(ctx({ ...v.over, approvalMode: mode }));
        expect(text.includes(AUTONOMOUS_SECTION_TITLE), `${v.id}/${mode}`).toBe(mode === 'auto');
      }
    }
  });

  it('says what to do instead of asking, and what still stops for the user', () => {
    const text = buildSystemPrompt(ctx({ approvalMode: 'auto' }));
    expect(text).toMatch(/Don't ask clarifying or permission questions/);
    expect(text).toMatch(/list them in your final answer/);
    expect(text).toMatch(/purchases, payments, passwords, sending messages and destructive actions outside the project/);
    // It replaces the "tools may prompt the user" paragraph rather than adding to it.
    expect(text).not.toContain('## Permission flow');
    expect(buildSystemPrompt(ctx({ approvalMode: 'manual' }))).toContain('## Permission flow');
  });

  it('auto answers the skill-install question itself (no "First ASK the user")', () => {
    const auto = buildSystemPrompt(ctx({ approvalMode: 'auto' }));
    expect(auto).not.toMatch(/First ASK the user/);
    expect(auto).toMatch(/proceed with your built-in knowledge \(auto mode: don't ask, don't install\)/);
    expect(buildSystemPrompt(ctx({ approvalMode: 'manual' }))).toMatch(/First ASK the user/);
  });

  it('plan mode in auto: the plan is approved automatically and carried out in the same turn', () => {
    const plan = buildSystemPrompt(ctx({ mode: 'plan', approvalMode: 'auto' }));
    expect(plan).toContain(AUTONOMOUS_SECTION_TITLE);
    expect(plan).toMatch(/approved automatically/);
    expect(buildAutonomousSection('subagent')).toMatch(/note assumptions in your report/);
  });

  it('strict + auto keeps the discipline but never waits for a reply', () => {
    setStrictMode(true);
    expect(buildSystemPrompt(ctx({ approvalMode: 'auto' }))).toMatch(/do not wait for approval or a next message/);
    expect(buildSystemPrompt(ctx({ approvalMode: 'manual' }))).not.toMatch(/Strict \+ auto mode/);
  });

  it('without an explicit approvalMode the live session mode decides', () => {
    expect(buildSystemPrompt(ctx())).not.toContain(AUTONOMOUS_SECTION_TITLE);
    setApprovalMode('auto');
    expect(buildSystemPrompt(ctx())).toContain(AUTONOMOUS_SECTION_TITLE);
  });
});

describe('eval budgets hold in auto mode', () => {
  it('every prompt variant stays within its token budget (and no larger than manual + 60 tokens)', () => {
    for (const v of VARIANTS) {
      const auto = P.countTokens(buildSystemPrompt(ctx({ ...v.over, approvalMode: 'auto' })));
      const manual = P.countTokens(buildSystemPrompt(ctx({ ...v.over, approvalMode: 'manual' })));
      expect(auto, `${v.id}: ${auto} > ${v.budget}`).toBeLessThanOrEqual(v.budget);
      expect(auto - manual, `${v.id}: auto adds ${auto - manual} tokens`).toBeLessThanOrEqual(60);
    }
  });

  it('no declared contradiction in the auto variants', () => {
    for (const v of VARIANTS) {
      const text = buildSystemPrompt(ctx({ ...v.over, approvalMode: 'auto' }));
      for (const pair of CONTRADICTION_PAIRS) {
        expect(pair.a.test(text) && pair.b.test(text), `${v.id}/${pair.id}`).toBe(false);
      }
    }
  });
});
