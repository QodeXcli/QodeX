/**
 * Prompt task classes 'web' / 'desktop' (EN + FA), their addenda, the `# Your Computer`
 * system-prompt section and the general-agent identity.
 */
import { describe, it, expect } from 'vitest';
import { classifyTaskForPrompt, containsUrlOrDomain, normalizeForClassify } from '../src/agent/task-classifier.js';
import { systemAddendumFor } from '../src/llm/prompts/task-addenda.js';
import { buildSystemPrompt, buildComputerSection, detectComputerFamilies } from '../src/llm/prompts/system.js';

describe('classifyTaskForPrompt — web vs frontend vs desktop', () => {
  const table: Array<[string, string]> = [
    // web (EN)
    ['go to digikala.com and add an iPhone to the cart', 'web'],
    ['open https://example.com and tell me the title', 'web'],
    ['log in to github.com and star the repo qodex', 'web'],
    ['go to https://api.example.com/docs and summarize the REST API', 'web'],
    ['add an iPhone 15 to my cart on amazon', 'web'],
    ['book a table for two at 8pm on opentable', 'web'],
    ['fill out the contact form on example.org with my details', 'web'],
    ['sign up for the newsletter on example.com', 'web'],
    ['find the cheapest flight from Tehran to Istanbul next week', 'web'],
    ["what's on news.ycombinator.com today?", 'web'],
    ['scrape the product prices from https://shop.example.com into a csv', 'web'],
    // web (FA)
    ['برو تو سایت دیجی‌کالا و یه گوشی سامسونگ ارزون پیدا کن', 'web'],
    ['دیجی‌کالا رو باز کن', 'web'],
    ['از دیجی‌کالا یه هدفون بخر', 'web'],
    ['سفارش رو ثبت کن و یه بلیط رزرو کن', 'web'],
    ['فرم ثبت نام رو پر کن', 'web'],
    ['وارد سایت بانک شو', 'web'],
    ['برو تو سایت و یه اکانت بساز', 'web'],
    ['کدام سایت ارزان‌تره؟ دیجی‌کالا یا ترب', 'web'],
    // coding requests that mention sites stay coding
    ['build a landing page', 'frontend'],
    ['fix the login form component', 'frontend'],
    ['یه سایت فروشگاهی بساز', 'frontend'],
    ['add a buy button to the product page', 'frontend'],
    ['add a link to https://example.com in the footer', 'frontend'],
    ['open the settings page and add a dark mode toggle', 'frontend'],
    ['open https://github.com/foo/bar/blob/main/src/app.ts and fix the bug', 'debug'],
    ['the api at https://api.x.com returns 500, fix our client', 'debug'],
    ['design the Django models for orders', 'backend'],
    // desktop
    ['open the Notes app and write a shopping list', 'desktop'],
    ['take a screenshot of my screen and tell me what is open', 'desktop'],
    ['open Finder and show the Downloads folder', 'desktop'],
    ['click on the Save button in Photoshop', 'desktop'],
    ['روی دسکتاپ یه پوشه جدید بساز', 'desktop'],
    ['برنامه تلگرام رو باز کن', 'desktop'],
    // legacy classes unchanged
    ['refactor the auth module', 'refactor'],
    ['fix the crash in parser', 'debug'],
    ['explain how the router works', 'explain'],
    ['review the payment module for smells', 'review'],
    ['what are the pros and cons of postgres vs mongo for us', 'analysis'],
    ['hello', 'general'],
  ];
  for (const [text, want] of table) {
    it(`${want}: ${text}`, () => expect(classifyTaskForPrompt(text)).toBe(want));
  }
});

describe('URL / domain detection', () => {
  it('finds URLs, bare domains and localhost:port', () => {
    expect(containsUrlOrDomain('see https://x.dev/a?b=1')).toBe(true);
    expect(containsUrlOrDomain('برو تو digikala.com')).toBe(true);
    expect(containsUrlOrDomain('www.example.co is down')).toBe(true);
    expect(containsUrlOrDomain('open localhost:5173')).toBe(true);
  });
  it('ignores code, file names and e-mails', () => {
    expect(containsUrlOrDomain('this.app.use(router)')).toBe(false);
    expect(containsUrlOrDomain('edit next.config.js and package.json')).toBe(false);
    expect(containsUrlOrDomain('mail me at a@b.com')).toBe(false);
    expect(containsUrlOrDomain('fix the bug in src/main.ts')).toBe(false);
  });
  it('normalizes Persian spelling (ZWNJ, Arabic ye/kaf)', () => {
    expect(normalizeForClassify('دیجی‌كالا  را باز كن')).toBe('دیجی کالا را باز کن');
  });
});

describe('task addenda for web / desktop', () => {
  it('web automation playbook', () => {
    const a = systemAddendumFor('web');
    expect(a.startsWith('\n\n## Task profile: web automation')).toBe(true);
    for (const s of ['browser_snapshot', 'ref', 'browser_agent', 'mission_start', 'browser_fill_secret', 'Sentinel', 'untrusted', 'evidence']) {
      expect(a).toContain(s);
    }
    expect(a).not.toContain('Keep your context small'); // no delegation nudge
  });
  it('desktop control playbook', () => {
    const a = systemAddendumFor('desktop');
    expect(a.startsWith('\n\n## Task profile: desktop control')).toBe(true);
    for (const s of ['SCREENSHOT pixels', 'computer_use_locate', 'computer_use_agent', 'Sentinel', 'untrusted']) {
      expect(a).toContain(s);
    }
  });
});

describe('system prompt: general agent identity + # Your Computer', () => {
  const base = {
    cwd: '/tmp/proj',
    mode: 'normal' as const,
    modelFamily: 'qwen' as const,
    projectInfo: { languages: ['TypeScript'] },
    knowledgeFacts: [],
    directoryTree: '.',
    availableToolNames: ['read_file', 'shell'],
  };
  const computerTools = [
    'read_file', 'shell', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_agent',
    'computer_use_screenshot', 'computer_use_locate', 'mission_start', 'workflow_run', 'workflow_record',
    'vault_list', 'browser_fill_secret',
  ];

  it('keeps every asserted identity / discipline string', () => {
    const p = buildSystemPrompt({ ...base, availableToolNames: computerTools });
    for (const s of ['QodeX', 'CONCRETE FINDINGS REPORT', 'Answer the question that was asked', 'code_graph_', 'exactly ONCE', 'gather', 'one-off Python script']) {
      expect(p).toContain(s);
    }
    expect(p).toMatch(/Don't hammer a failing tool/i);
    expect(p.toLowerCase()).toContain("compute, don't guess");
    expect(p).not.toContain('currently routing this request');
  });

  it('describes QodeX as an autonomous agent with its own computer when the tools exist', () => {
    const p = buildSystemPrompt({ ...base, availableToolNames: computerTools });
    expect(p).toContain('autonomous agent');
    expect(p).toContain('a dedicated browser');
    const header = p.indexOf('\n# Your Computer\n');
    expect(header).toBeGreaterThan(0);
    expect(header).toBeLessThan(p.indexOf('\n# Output Style\n'));
    expect(header).toBeGreaterThan(p.indexOf('\n# Data gathering'));
  });

  it('omits # Your Computer (and the computer claim) when no browser/desktop/mission tools exist', () => {
    const p = buildSystemPrompt(base);
    expect(p).not.toContain('# Your Computer');
    expect(p).not.toContain('a dedicated browser');
    expect(p).toContain('You are QodeX');
  });

  it('the section is stable, compact and adapts to the available families', () => {
    const full = buildComputerSection(detectComputerFamilies(computerTools));
    expect(full.split('\n').length).toBeLessThanOrEqual(25);
    for (const s of ['browser_snapshot', 'ref', 'browser_agent', 'SCREENSHOT pixels', 'computer_use_locate', 'mission_start', 'workflow_record', 'browser_fill_secret', 'Sentinel', 'untrusted data']) {
      expect(full).toContain(s);
    }
    expect(full).not.toMatch(/\d{4}-\d{2}-\d{2}/); // nothing volatile
    expect(buildComputerSection(detectComputerFamilies(computerTools))).toBe(full);

    const browserOnly = buildComputerSection(detectComputerFamilies(['browser_snapshot', 'browser_click']));
    expect(browserOnly).toContain('Dedicated browser');
    expect(browserOnly).not.toContain('computer_use_');
    expect(browserOnly).not.toContain('mission_start');
    expect(browserOnly).not.toContain('browser_agent'); // not registered → not advertised
    expect(browserOnly).toContain('untrusted data');
  });

  it('injects the web / desktop addendum in normal mode', () => {
    expect(buildSystemPrompt({ ...base, taskClass: 'web' })).toContain('## Task profile: web automation');
    expect(buildSystemPrompt({ ...base, taskClass: 'desktop' })).toContain('## Task profile: desktop control');
    expect(buildSystemPrompt({ ...base, mode: 'subagent', taskClass: 'web' })).not.toContain('## Task profile: web automation');
  });
});
