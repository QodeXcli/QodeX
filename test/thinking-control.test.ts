import { describe, it, expect } from 'vitest';
import {
  decideThinking, applyThinkingDecision, countTrailingToolErrors, modelSupportsSoftSwitch,
} from '../src/agent/thinking-control.js';
import type { Message } from '../src/session/store.js';

describe('decideThinking', () => {
  it('thinks on the first iteration (plan the approach)', () => {
    expect(decideThinking({ iteration: 1, taskComplex: true, recentToolErrors: 0, forceThink: false })).toBe('think');
  });
  it('skips thinking on routine mid-task steps', () => {
    expect(decideThinking({ iteration: 5, taskComplex: true, recentToolErrors: 0, forceThink: false })).toBe('no_think');
  });
  it('thinks after tool errors (diagnose, do not thrash)', () => {
    expect(decideThinking({ iteration: 5, taskComplex: false, recentToolErrors: 2, forceThink: false })).toBe('think');
  });
  it('thinks when forced (steering / verify repair)', () => {
    expect(decideThinking({ iteration: 5, taskComplex: false, recentToolErrors: 0, forceThink: true })).toBe('think');
  });
  it('re-grounds periodically on complex tasks only', () => {
    expect(decideThinking({ iteration: 8, taskComplex: true, recentToolErrors: 0, forceThink: false })).toBe('think');
    expect(decideThinking({ iteration: 8, taskComplex: false, recentToolErrors: 0, forceThink: false })).toBe('no_think');
  });
});

describe('modelSupportsSoftSwitch', () => {
  it('matches the Qwen3 family, not others', () => {
    expect(modelSupportsSoftSwitch('qwen3.5-122b-a10b-lm-mlx-6')).toBe(true);
    expect(modelSupportsSoftSwitch('Qwen3-Coder-Next')).toBe(true);
    expect(modelSupportsSoftSwitch('gemma-4-31b-it')).toBe(false);
    expect(modelSupportsSoftSwitch('nvidia-nemotron-3-super-120b')).toBe(false);
  });
});

describe('countTrailingToolErrors', () => {
  it('counts [ERROR] results in the trailing tool block only', () => {
    const msgs: Message[] = [
      { role: 'tool', content: '[ERROR] old — not counted' } as any,
      { role: 'assistant', content: 'x' },
      { role: 'tool', content: '[ERROR] file not found' } as any,
      { role: 'tool', content: 'ok done' } as any,
      { role: 'tool', content: '[ERROR] permission denied' } as any,
    ];
    expect(countTrailingToolErrors(msgs)).toBe(2);
  });
});

describe('applyThinkingDecision', () => {
  const hist: Message[] = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'working' },
  ];
  it('appends /no_think only at the tail of a NEW array (history untouched)', () => {
    const out = applyThinkingDecision(hist, 'no_think', 'qwen3.5-122b');
    expect(out).toHaveLength(3);
    expect(out[2]!.content).toBe('/no_think');
    expect(hist).toHaveLength(2);
  });
  it('is a no-op for think decisions (model default) and non-Qwen models', () => {
    expect(applyThinkingDecision(hist, 'think', 'qwen3.5-122b')).toBe(hist);
    expect(applyThinkingDecision(hist, 'no_think', 'gemma-4-31b')).toBe(hist);
  });
});
