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
  controls: [
    { path: 'context.efficient', label: 'Efficient mode', group: 'Performance', type: 'bool', current: 'false' },
    { path: 'memory.mode', label: 'Memory injection', group: 'Memory', type: 'enum', values: ['full', 'lightweight', 'auto'], current: 'auto' },
  ],
  schedules: [{ id: 'sched1234', name: 'nightly-deps', cron: '@daily', enabled: true, recipe: 'verified-pr' }],
  models: ['qwen3-coder', 'anthropic/claude-3.5'],
  candidates: [{ name: 'add-pagination', description: 'cursor pagination playbook', confidence: 82 }],
  runs: [{ schedule: 'nightly-deps', recipe: 'maintain · unused-imports', when: '3h ago', status: 'success', receipt: { status: 'opened', prUrl: 'https://h/pr/9', verification: [{ command: 'tsc', passed: true }] } }],
  bot: { running: false },
  health: [{ label: 'Provider keys', ok: true, detail: '1/1 cloud keys set' }, { label: 'Bot', ok: true, detail: 'stopped' }],
  logs: ['2026-06-30 INFO started', '2026-06-30 INFO ready'],
  userModel: { preferences: ['prefers Persian comments'], recentThemes: ['pagination', 'auth'], favoriteAreas: ['src/api'], taskCount: 3, summary: '1 stated preference · recent focus: pagination, auth · works mostly in src/api' },
  maintainStats: { totalRuns: 3, opened: 2, blocked: 1, failed: 0, successRate: 0.66, filesCleaned: 10, estMinutesSaved: 10, byScope: [{ scope: 'unused-imports', runs: 2, opened: 2 }], lastRun: { when: '2h ago', status: 'opened', scope: 'unused-imports' } },
  maintainWeekly: { opened: 2, blocked: 1, filesCleaned: 10, minutesSaved: 10, priorOpened: 1, openedDelta: 1 },
  maintainNext: { scope: 'dead-code', why: 'never run here yet — try it' },
  maintainTrend: [0, 0, 1, 0, 2, 1, 0, 3],
  maintainProjection: { cleanupsPerMonth: 6, minutesPerMonth: 30 },
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
    const empty: DashboardData = { project: 'x', model: 'm', generatedAt: 't', providers: [], sessions: [], facts: [], episodes: [], skills: [], controls: [], schedules: [], models: [], candidates: [], runs: [], bot: { running: false }, health: [], logs: [], userModel: { preferences: [], recentThemes: [], favoriteAreas: [], taskCount: 0, summary: '' }, totals: { sessions: 0, tokens: 0, cost: 0, facts: 0, episodes: 0, skills: 0 } };
    const html = buildDashboardHtml(empty);
    expect(html).toContain('No sessions yet');
    expect(html).toContain('Nothing learned yet');
  });

  it('read-only render shows control STATE but no action JS; live render wires the API', () => {
    const ro = buildDashboardHtml(data);
    expect(ro).toContain('Efficient mode');
    expect(ro).not.toContain('function act(');            // no controls without a token
    expect(ro).toContain('Read-only snapshot');
    const live = buildDashboardHtml(data, { token: 'tok123' });
    expect(live).toContain('function act(');               // live: action JS wired
    expect(live).toContain('tok123');
    expect(live).toContain("act('schedule.setEnabled'");    // schedule controls present
    expect(live).toContain("act('config.set'");            // config toggles present
    expect(live).toContain("act('model.set'");             // model switcher
    expect(live).toContain("act('memory.add'");            // remember input
    expect(live).toContain("act('skill.promote'");         // candidate promote
    expect(live).toContain('add-pagination');              // candidate listed
    expect(live).toContain("act('schedule.add'");          // schedule-add form
    expect(live).toContain('Run history');                 // receipts panel
    expect(live).toContain('🧾 opened');                    // receipt verdict surfaced
    expect(live).toContain('https://h/pr/9');              // receipt PR link
    expect(live).toContain("act('provider.add'");          // provider add form
    expect(live).toContain("act('provider.test'");         // per-provider test button
    expect(live).toContain("act('bot.start'");             // bot lifecycle (stopped → Start)
    expect(live).toContain("act('app.update'");            // self-update button
    expect(live).toContain('Recent log');                  // observability log panel
    expect(live).toContain('Health');                      // health badges
    expect(live).toContain('Maintain status');             // maintain analytics panel
    expect(live).toContain('cleanups shipped');            // maintain stat card
    expect(live).toContain('This week');                   // weekly trend
    expect(live).toContain('Suggested next');              // auto scope recommendation
    expect(live).toContain("act('maintain.preview'");      // "Run maintain now (preview)" button
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
