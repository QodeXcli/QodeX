import { describe, it, expect } from 'vitest';
import { tokenize, termFreq, cosineSim, findSimilarPairs, skillSimilarityText } from '../src/skills/learning/similarity.js';
import { toShareGpt } from '../src/agent/dataset-export.js';
import { parseMergeResult } from '../src/skills/learning/judge.js';

describe('Gap 1 — semantic similarity for skill dedup', () => {
  it('tokenize drops stopwords and short tokens', () => {
    expect(tokenize('Build a React form with validation')).toEqual(['build', 'react', 'form', 'validation']);
  });
  it('cosine: identical text → 1, disjoint → 0', () => {
    const a = termFreq(tokenize('create react button component'));
    expect(cosineSim(a, a)).toBeCloseTo(1, 5);
    const b = termFreq(tokenize('configure postgres database backup'));
    expect(cosineSim(a, b)).toBe(0);
  });
  it('finds near-duplicate React skills but not the unrelated one', () => {
    const items = [
      { name: 'create-react-button', text: skillSimilarityText('create-react-button', 'Create a React button component with variants', 'render a styled button in React with props for variant and size') },
      { name: 'build-react-form', text: skillSimilarityText('build-react-form', 'Build a React form component with validation', 'render a React form with input components and validation state') },
      { name: 'setup-postgres', text: skillSimilarityText('setup-postgres', 'Configure a Postgres database connection', 'create a postgres pool and run migrations') },
    ];
    const pairs = findSimilarPairs(items, 0.25);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const top = pairs[0]!;
    expect(new Set([top.a, top.b])).toEqual(new Set(['create-react-button', 'build-react-form']));
    // the postgres skill is not similar to either React skill
    expect(pairs.some(p => p.a === 'setup-postgres' || p.b === 'setup-postgres')).toBe(false);
  });
  it('threshold gates: a high threshold yields no pairs', () => {
    const items = [
      { name: 'a', text: 'react button component variant' },
      { name: 'b', text: 'react form component validation' },
    ];
    expect(findSimilarPairs(items, 0.95).length).toBe(0);
  });
});

describe('Gap 1 — merge result parsing fails CLOSED', () => {
  it('accepts a valid merge with machine frontmatter', () => {
    const md = '---\nname: react-components\ndescription: d\nprovenance: machine\nstatus: candidate\n---\nbody';
    const r = parseMergeResult(JSON.stringify({ merge: true, name: 'react-components', skillMd: md }));
    expect(r.merge).toBe(true);
    expect(r.name).toBe('react-components');
  });
  it('rejects merge=false, bad name, or missing machine frontmatter', () => {
    expect(parseMergeResult(JSON.stringify({ merge: false })).merge).toBe(false);
    expect(parseMergeResult(JSON.stringify({ merge: true, name: 'Bad Name', skillMd: 'provenance: machine' })).merge).toBe(false);
    expect(parseMergeResult(JSON.stringify({ merge: true, name: 'ok', skillMd: 'no frontmatter' })).merge).toBe(false);
    expect(parseMergeResult('garbage').merge).toBe(false);
  });
});

describe('Gap 3 — ShareGPT export conversion', () => {
  it('maps roles and embeds tool calls + results', () => {
    const rec = toShareGpt([
      { role: 'system', content: 'You are QodeX.' },
      { role: 'user', content: 'Fix the bug' },
      { role: 'assistant', content: 'Reading the file.', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', content: 'file contents…', name: 'read_file', tool_call_id: '1' },
      { role: 'assistant', content: 'Fixed it.' },
    ]);
    expect(rec.conversations.map(c => c.from)).toEqual(['system', 'human', 'gpt', 'tool', 'gpt']);
    expect(rec.conversations[2]!.value).toContain('[tool calls]');
    expect(rec.conversations[2]!.value).toContain('read_file({"path":"a.ts"})');
    expect(rec.conversations[3]!.value).toContain('[read_file]');
  });
  it('drops empty turns', () => {
    const rec = toShareGpt([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },          // empty → dropped
      { role: 'assistant', content: 'response' },
    ]);
    expect(rec.conversations).toHaveLength(2);
    expect(rec.conversations.map(c => c.value)).toEqual(['hi', 'response']);
  });
});
