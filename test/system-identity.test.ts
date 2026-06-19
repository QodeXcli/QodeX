import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/llm/prompts/system.js';

const base = {
  cwd: '/tmp/proj',
  mode: 'normal' as const,
  modelFamily: 'qwen' as const,
  projectInfo: { languages: ['TypeScript'] },
  knowledgeFacts: [],
  directoryTree: '.',
  availableToolNames: ['read_file'],
};

describe('system prompt identity', () => {
  it('reports the REAL runtime model when provided', () => {
    const p = buildSystemPrompt({
      ...base,
      modelId: 'qwen3-235b-a22b-instruct-2507-mlx',
      providerName: 'openai',
    });
    expect(p).toContain('qwen3-235b-a22b-instruct-2507-mlx');
    expect(p).toContain('served via openai');
  });

  it('never hardcodes a fake default model in the identity section', () => {
    const p = buildSystemPrompt({
      ...base,
      modelId: 'qwen3-235b-a22b-instruct-2507-mlx',
      providerName: 'openai',
    });
    // The old bug: prompt told the model to say "qwen2.5-coder via Ollama".
    // That example must be gone so the model can't parrot it.
    expect(p).not.toContain('qwen2.5-coder via Ollama');
  });

  it('still identifies as QodeX and omits the model line when none is known', () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain('QodeX');
    expect(p).not.toContain('currently routing this request');
  });

  it('guards analysis/audit tasks against drifting into generic advice or sales copy', () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain('CONCRETE FINDINGS REPORT');
    expect(p).toMatch(/marketing\/sales copy|pitch/i);
    expect(p).toContain('Answer the question that was asked');
  });

  it('tells the agent not to hammer a tool that keeps returning NOT_FOUND', () => {
    const p = buildSystemPrompt(base);
    expect(p).toMatch(/Don't hammer a failing tool/i);
    expect(p).toContain('code_graph_');
  });
});

describe('system prompt anti-duplication directive', () => {
  it('instructs the model to output its final response exactly once', () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain('exactly ONCE');
    expect(p.toLowerCase()).toContain('do not repeat');
  });
});

describe('system prompt data-gathering strategy', () => {
  it('teaches gather (native recon) vs a one-off Python script (heavy compute)', () => {
    const p = buildSystemPrompt(base);
    expect(p).toContain('gather'); // native parallel recon path
    expect(p).toContain('one-off Python script'); // heavy/project-specific compute path
    expect(p.toLowerCase()).toContain("compute, don't guess");
  });
});

