/**
 * Tool relevance gating for the agent-platform families: the browser (+ vault) family on
 * site / URL / Persian site commands, the workflow_ and mission_ families, the expanded
 * computer family — without regressing the existing coding-task gating.
 */
import { describe, it, expect } from 'vitest';
import { selectRelevantToolNames, hasUrlOrDomain } from '../src/agent/tool-relevance.js';

const ALL = [
  'read_file', 'write_file', 'edit_text', 'multi_edit', 'edit_symbol', 'multi_file_edit',
  'ls', 'glob', 'grep', 'shell', 'todo_write', 'todo_read', 'remember', 'recall', 'task',
  'orchestrate', 'gather', 'use_skill', 'search_skills', 'diagnostics',
  'git_status', 'git_commit', 'web_search', 'web_fetch', 'vision_analyze', 'design_audit', 'explain_codebase',
  'browser_navigate', 'browser_click', 'browser_snapshot', 'browser_screenshot', 'browser_agent', 'browser_fill_secret',
  'vault_list',
  'computer_use_screenshot', 'computer_use_click', 'computer_use_open',
  'workflow_record', 'workflow_run', 'workflow_list',
  'mission_start', 'mission_status', 'mission_list',
  'docker_build', 'db_query', 'artifact_create', 'install_skill',
];
const sel = (s: string) => selectRelevantToolNames(ALL, s);
const names = (s: string) => sel(s).selected;

describe('browser family (+ vault) — sites, URLs and Persian site commands', () => {
  const browserish = [
    'go to digikala.com and find a cheap phone',
    'open https://example.com',
    'log in to my bank account and download the statement',
    'sign in to the dashboard',
    'add this to the shopping cart and checkout',
    'book a table for tonight',
    'make a reservation for two',
    'compare prices on this website',
    'open a new tab',
    'check localhost:3000 in the browser',
    'برو تو سایت دیجی‌کالا',
    'دیجی‌کالا رو باز کن',
    'وارد سایت شو و فرم رو پر کن',
    'یه بلیط رزرو کن',
    'سفارش بده',
    'به سبد خرید اضافه کن',
    'ثبت‌نام کن تو سایت',
    'لاگین کن',
  ];
  for (const s of browserish) {
    it(`pulls browser_* and vault_*: ${s}`, () => {
      const n = names(s);
      expect(n.has('browser_click')).toBe(true);
      expect(n.has('browser_snapshot')).toBe(true);
      expect(n.has('browser_fill_secret')).toBe(true);
      expect(n.has('vault_list')).toBe(true);
    });
  }

  it('a URL or bare domain alone is never trivial', () => {
    expect(sel('digikala.com').trivial).toBe(false);
    expect(sel('https://x.io').trivial).toBe(false);
    expect(hasUrlOrDomain('see www.example.co')).toBe(true);
    expect(hasUrlOrDomain('this.app.use(x)')).toBe(false);
  });

  it('short Persian site commands are not trivial and pull the browser', () => {
    const r = sel('دیجی‌کالا رو باز کن');
    expect(r.trivial).toBe(false);
    expect(r.selected.has('browser_navigate')).toBe(true);
  });

  it('ZWNJ / space spelling variants match alike', () => {
    expect(names('وب‌سایت رو چک کن').has('browser_click')).toBe(true);
    expect(names('وب سایت رو چک کن').has('browser_click')).toBe(true);
    expect(names('ثبت نام کن').has('browser_click')).toBe(true);
  });
});

describe('workflow_ and mission_ families', () => {
  it('workflow keywords (EN + FA)', () => {
    for (const s of ['record this workflow so you can replay it', 'automate this every time', 'let me demonstrate how I do it', 'این کار رو ضبط کن و یاد بگیر', 'یه ورک‌فلو بساز']) {
      expect(names(s).has('workflow_run'), s).toBe(true);
      expect(names(s).has('workflow_record'), s).toBe(true);
    }
  });
  it('mission keywords (EN + FA)', () => {
    for (const s of ['start a mission to monitor prices', 'keep working on this overnight', 'run it in the background and tell me when done', 'every day check my inbox', 'یه ماموریت تعریف کن', 'تو پس‌زمینه انجامش بده', 'هر روز پیگیری کن']) {
      expect(names(s).has('mission_start'), s).toBe(true);
    }
  });
  it('CSS "background" does not pull missions; "border" / "in order to" do not pull the browser', () => {
    expect(names('change the background color of the hero section').has('mission_start')).toBe(false);
    expect(names('add a 1px border to the card in order to separate it').has('browser_click')).toBe(false);
  });
});

describe('computer family (desktop apps)', () => {
  for (const s of ['open the Notes app', 'open Finder', 'change it in System Settings', 'اپلیکیشن تلگرام رو باز کن', 'پنجره رو ببند', 'برو تو تنظیمات']) {
    it(`pulls computer_use_*: ${s}`, () => expect(names(s).has('computer_use_click')).toBe(true));
  }
  it('code paths like app.tsx or "apply" do not pull desktop tools', () => {
    expect(names('fix the type error in app.tsx').has('computer_use_click')).toBe(false);
    expect(names('apply the patch to utils').has('computer_use_click')).toBe(false);
  });
});

describe('existing gating guarantees still hold', () => {
  it('Persian bug-find task does not pull the browser / docker / db', () => {
    const n = names('باگ‌های هیرو رو پیدا کن');
    expect(n.has('browser_click')).toBe(false);
    expect(n.has('docker_build')).toBe(false);
    expect(n.has('db_query')).toBe(false);
    expect(n.has('mission_start')).toBe(false);
    expect(n.has('workflow_run')).toBe(false);
  });
  it('plain coding tasks stay lean', () => {
    expect(names('fix the typo in the readme').has('docker_build')).toBe(false);
    expect(names('fix the type error in math.ts').has('artifact_create')).toBe(false);
    expect(names('refactor the auth module').has('browser_click')).toBe(false);
  });
  it('greetings stay trivial', () => {
    expect(sel('who are you?').trivial).toBe(true);
    expect(sel('سلام').trivial).toBe(true);
    expect(names('سلام').has('browser_click')).toBe(false);
  });
});
