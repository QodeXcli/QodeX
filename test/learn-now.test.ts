import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LearnMessage } from '../src/skills/learning/learn-now.js';

const call = (name: string, args: Record<string, unknown> = {}) => ({ function: { name, arguments: JSON.stringify(args) } });

const SESSION: LearnMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'old task' },
  { role: 'assistant', content: 'done old' },
  { role: 'user', content: 'Add a dark mode toggle to the settings page' },
  { role: 'assistant', content: null, tool_calls: [call('read_file', { path: 'src/settings.tsx' })] },
  { role: 'tool', content: '...' },
  { role: 'assistant', content: null, tool_calls: [call('edit_text', { path: 'src/settings.tsx' }), call('write_file', { path: 'src/theme.ts' })] },
  { role: 'tool', content: 'ok' },
  { role: 'assistant', content: null, tool_calls: [call('shell', { command: 'npm test' })] },
  { role: 'tool', content: 'pass' },
  { role: 'user', content: '[STANDING GOAL — round 1 of 3] not met' },
  { role: 'assistant', content: 'Added a ThemeToggle with persisted preference; tests pass.' },
];

describe('/learn', () => {
  const realHome = process.env.HOME;
  let home: string;
  beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'qx-learn-')); process.env.HOME = home; });
  afterAll(() => { process.env.HOME = realHome; });

  it('digests only the latest real request (injected goal turns do not count as requests)', async () => {
    const { digestLatestTask } = await import('../src/skills/learning/learn-now.js');
    const d = digestLatestTask(SESSION)!;
    expect(d.prompt).toBe('Add a dark mode toggle to the settings page');
    expect(d.toolSequence).toEqual(['read_file', 'edit_text', 'write_file', 'shell']);
    expect(d.filesChanged.sort()).toEqual(['src/settings.tsx', 'src/theme.ts']);
    expect(d.finalSummary).toMatch(/ThemeToggle/);
    expect(digestLatestTask([{ role: 'system', content: 'x' }])).toBeNull();
  });

  it('names: user-given (sanitized) or derived from the request', async () => {
    const { learnSkillName } = await import('../src/skills/learning/learn-now.js');
    expect(learnSkillName('Dark Mode!!', 'x')).toBe('dark-mode');
    expect(learnSkillName(undefined, 'Add a dark mode toggle to the settings page')).toBe('add-a-dark-mode-toggle');
    expect(learnSkillName('حالت تاریک', 'Add dark mode')).toBe('add-dark-mode');
  });

  it('installs an active skill the loader can find; a web task without file edits works too', async () => {
    const os2 = await import('os');
    expect(os2.homedir()).toBe(home);
    const { learnFromSession } = await import('../src/skills/learning/learn-now.js');
    const r = await learnFromSession(SESSION, home, { name: 'dark-mode', nowIso: '2026-10-03T00:00:00Z' });
    expect(r.ok).toBe(true);
    const md = fs.readFileSync(path.join(r.dest!, 'SKILL.md'), 'utf8');
    expect(md).toMatch(/^name: dark-mode$/m);
    expect(md).toMatch(/^status: active$/m);
    expect(md).toMatch(/Skill captured with \/learn/);
    expect(md).toMatch(/src\/theme\.ts/);

    const web: LearnMessage[] = [
      { role: 'user', content: 'Find the cheapest flight to Istanbul next Friday' },
      { role: 'assistant', content: null, tool_calls: [call('browser_navigate', { url: 'https://flights.example' })] },
      { role: 'assistant', content: null, tool_calls: [call('browser_fill_form'), call('browser_click')] },
      { role: 'assistant', content: 'Cheapest: 129 EUR, 07:40.' },
    ];
    const w = await learnFromSession(web, home, { nowIso: '2026-10-03T00:00:00Z' });
    expect(w.ok).toBe(true);
    expect(fs.readFileSync(path.join(w.dest!, 'SKILL.md'), 'utf8')).toMatch(/none — not a file-editing task/);

    const thin = await learnFromSession([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], home);
    expect(thin.ok).toBe(false);
  });
});
