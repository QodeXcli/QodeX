import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionInsights, formatInsights, formatInsightsMarkdown, parseInsightsSnapshot } from '../src/agent/insights.js';
import { SessionStore } from '../src/session/store.js';

describe('SessionInsights', () => {
  it('accumulates tokens, cache, cost, and latency', () => {
    const s = new SessionInsights('abc-session', 1_000);
    s.recordLlm({
      input: 100, output: 20, cacheRead: 900, cacheCreation: 50,
      costUsd: 0.0123, thinkMs: 400, generateMs: 800,
    }, 2_000);
    s.recordTool({ name: 'edit_text', ok: true, durationMs: 30 }, 2_100);
    s.recordTool({ name: 'bash', ok: true, durationMs: 120 }, 2_300);
    s.recordTool({ name: 'bash', ok: false, durationMs: 10 }, 2_400);

    const snap = s.snapshot();
    expect(snap.sessionId).toBe('abc-session');
    expect(snap.tokens).toMatchObject({
      input: 100, output: 20, cacheRead: 900, cacheCreation: 50, llmCalls: 1,
    });
    expect(snap.tokens.costUsd).toBeCloseTo(0.0123, 6);
    expect(snap.latency).toEqual({ thinkMs: 400, generateMs: 800, toolMs: 160 });
    expect(snap.tools.bash).toEqual({ calls: 2, ok: 1, fail: 1, durationMs: 130 });
    expect(snap.tools.edit_text?.ok).toBe(1);
  });

  it('reset clears counters', () => {
    const s = new SessionInsights('x', 1);
    s.recordTool({ name: 'ls', ok: true, durationMs: 1 }, 2);
    s.reset(3);
    expect(s.isEmpty()).toBe(true);
    expect(s.snapshot().tools).toEqual({});
  });

  it('formatInsights mentions cache hit rate and the catalog caveat', () => {
    const s = new SessionInsights('deadbeef-xxxx', 0);
    s.recordLlm({
      input: 100_000, output: 1, cacheRead: 900_000, costUsd: 0.5,
      thinkMs: 1_500, generateMs: 2_000,
    }, 10_000);
    const text = formatInsights(s.snapshot());
    expect(text).toMatch(/deadbeef/);
    expect(text).toMatch(/90% of billed input/);
    expect(text).toMatch(/not an invoice/);
    expect(text).toMatch(/model wait \(TTFT\)/);
  });

  it('parseInsightsSnapshot round-trips', () => {
    const s = new SessionInsights('id-1', 5);
    s.recordLlm({ input: 3, output: 4, costUsd: 0.01, thinkMs: 1, generateMs: 2 }, 6);
    const parsed = parseInsightsSnapshot(JSON.parse(JSON.stringify(s.snapshot())));
    expect(parsed?.tokens.output).toBe(4);
    expect(parseInsightsSnapshot(null)).toBeNull();
    expect(parseInsightsSnapshot({ foo: 1 })).toBeNull();
  });

  it('formatInsightsMarkdown includes title and a fenced body', () => {
    const s = new SessionInsights('id-2', 0);
    s.recordLlm({ input: 1, output: 1, costUsd: 0, thinkMs: 0, generateMs: 0 }, 1);
    const md = formatInsightsMarkdown(s.snapshot(), { title: 'fix login', model: 'local', cwd: '/p' });
    expect(md).toMatch(/^# QodeX session /);
    expect(md).toMatch(/fix login/);
    expect(md).toMatch(/```/);
  });

  it('SessionStore persists and reloads the snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodex-insights-'));
    const store = new SessionStore(path.join(dir, 's.db'));
    const id = store.createSession('/proj', 'qwen');
    const s = new SessionInsights(id, 1);
    s.recordLlm({ input: 10, output: 2, costUsd: 0.001, thinkMs: 5, generateMs: 7 }, 2);
    store.saveInsights(id, s.snapshot());
    const loaded = parseInsightsSnapshot(store.loadInsightsJson(id));
    expect(loaded?.tokens.input).toBe(10);
    store.clearMessages(id);
    expect(store.loadInsightsJson(id)).toBeNull();
  });
});
