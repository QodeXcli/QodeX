import { describe, it, expect } from 'vitest';
import { isHighCapacityModel, buildSystemPrompt } from '../src/llm/prompts/system.js';

describe('isHighCapacityModel — frontier-class local models get the compressed prompt', () => {
  it('detects ≥70B param markers (the largest in the id)', () => {
    expect(isHighCapacityModel('qwen3-235b-a22b-instruct-2507-mlx')).toBe(true); // 235 wins over 22
    expect(isHighCapacityModel('llama-3.1-405b')).toBe(true);
    expect(isHighCapacityModel('nvidia/nemotron-3-super-120b-a12b')).toBe(true);
    expect(isHighCapacityModel('qwen2.5-72b-instruct')).toBe(true);
  });
  it('leaves small/mid local models on the verbose prompt', () => {
    expect(isHighCapacityModel('qwen2.5-coder:32b')).toBe(false); // below threshold — keeps guidance
    expect(isHighCapacityModel('qwen2.5-coder:7b')).toBe(false);
    expect(isHighCapacityModel('llama3.1:8b')).toBe(false);
    expect(isHighCapacityModel('mistral-7b')).toBe(false);
  });
  it('does not misfire on version numbers / non-param digits', () => {
    expect(isHighCapacityModel('gpt-4o')).toBe(false);          // 4o is not "Nb"
    expect(isHighCapacityModel('claude-sonnet-4-6')).toBe(false);
    expect(isHighCapacityModel('deepseek-v3')).toBe(false);     // no explicit param marker
  });
});

describe('a big local model actually gets a SHORTER prompt (less prefill / TTFT)', () => {
  const base = { cwd: '/x', mode: 'normal' as const, projectInfo: { languages: ['ts'] }, knowledgeFacts: [], directoryTree: '', availableToolNames: ['read_file', 'shell'] };
  it('compressed (235B) is meaningfully shorter than verbose (7B)', () => {
    const verbose = buildSystemPrompt({ ...base, modelFamily: 'qwen', modelId: 'qwen2.5-coder:7b' });
    const compact = buildSystemPrompt({ ...base, modelFamily: 'qwen', modelId: 'qwen3-235b-a22b' });
    expect(compact.length).toBeLessThan(verbose.length);
    expect(verbose.length - compact.length).toBeGreaterThan(1000); // hundreds of prefill tokens saved
  });
});
