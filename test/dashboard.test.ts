import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { buildDashboardHtml, gatherDashboardData, type DashboardData } from '../src/cli/dashboard.ts';

const data: DashboardData = {
  project: 'my-app', model: 'qwen3-coder', generatedAt: '2026-06-29 12:00',
  providers: [{ name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', keySet: true, models: ['anthropic/claude-3.5'], isDefault: true }],
  sessions: [{ id: 'abcd1234ef', title: 'add auth', model: 'qwen3-coder', turns: 5, tokens: 42000, cost: 0.12, when: '2h ago' }],
  facts: ['build is npm run build:prod'],
  episodes: [{ when: '1d ago', prompt: 'add pagination', summary: 'cursor pagination' }],
  skills: [{ name: 'living-artifact', description: 'build artifacts the right way' }],
  totals: { sessions: 1, tokens: 42000, cost: 0.12, facts: 1, episodes: 1, skills: 1 },
};

describe('qodex dashboard (pure render)', () => {
  it('renders a self-contained HTML page carrying every section of the data', () => {
    const html = buildDashboardHtml(data);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    for (const needle of ['my-app', 'qwen3-coder', 'openrouter', 'OPENROUTER_API_KEY', 'add auth',
      'build is npm run build:prod', 'add pagination', 'living-artifact', 'chart.js']) {
      expect(html).toContain(needle);
    }
    expect(html).toContain('42'); // token count, formatted
    expect(html).toContain('⭐');  // the default provider is starred
  });

  it('escapes HTML in data — no injection from a fact/title', () => {
    const html = buildDashboardHtml({ ...data, facts: ['<script>alert(1)</script>'] });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles an empty/fresh install gracefully', () => {
    const empty: DashboardData = { project: 'x', model: 'm', generatedAt: 't', providers: [], sessions: [], facts: [], episodes: [], skills: [], totals: { sessions: 0, tokens: 0, cost: 0, facts: 0, episodes: 0, skills: 0 } };
    const html = buildDashboardHtml(empty);
    expect(html).toContain('No sessions yet');
    expect(html).toContain('Nothing learned yet');
  });

  // Exercises the REAL gather chain (config + store + skills, read-only) for an empty cwd — proves it
  // never throws on a real install and that the result renders.
  it('gathers real data for a fresh cwd without crashing, then renders', async () => {
    const d = await gatherDashboardData(os.tmpdir());
    expect(typeof d.project).toBe('string');
    expect(Array.isArray(d.providers) && Array.isArray(d.sessions)).toBe(true);
    expect(d.totals.sessions).toBe(d.sessions.length);
    expect(buildDashboardHtml(d).startsWith('<!doctype html>')).toBe(true);
  });
});
