/**
 * H1 item 8 — the short CAPTCHA recipe in the prompts and the built-in "sign-up" /
 * "manage-site" skills (examples/skills, seeded into ~/.qodex/skills on first run).
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseSkill } from '../src/skills/loader.js';
import { systemAddendumFor } from '../src/llm/prompts/task-addenda.js';
import { getBuiltinRolePrompt } from '../src/llm/prompts/role-prompts.js';
import { buildBrowserAgentPrompt } from '../src/tools/browser/agent-tool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.resolve(HERE, '..', 'examples', 'skills');

async function load(name: string) {
  const dir = path.join(SKILLS, name);
  const raw = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  return { spec: parseSkill(raw, name, dir, 'builtin'), raw };
}

describe('prompts: one short CAPTCHA recipe (detect → wait → hand off; never touch it)', () => {
  it('web addendum', () => {
    const a = systemAddendumFor('web');
    expect(a).toContain('browser_request_human');
    expect(a).toMatch(/never click, type into,\s+drag, reload or screenshot-analyze/);
    expect(a).toContain('[CHALLENGE_UNSOLVED]');
    expect(a).not.toMatch(/tell the user; they can take over the live browser/);
    const para = a.slice(a.indexOf('CAPTCHA / bot check'), a.indexOf('Finish with evidence'));
    expect(para.split('\n').filter(Boolean).length).toBeLessThanOrEqual(5);
  });

  it('browser sub-agent role prompt and browser_agent operating guide', () => {
    expect(getBuiltinRolePrompt('browser')).toContain('browser_request_human');
    expect(getBuiltinRolePrompt('browser')).toMatch(/never click, type into, drag, reload or screenshot-analyze it/);
    const g = buildBrowserAgentPrompt('sign up on example.com');
    expect(g).toContain('browser_request_human');
    expect(g).toContain('[CHALLENGE_UNSOLVED]');
  });
});

describe('built-in skills', () => {
  it('sign-up: parses, bilingual triggers, vault-generated password, mail verification, hand-off', async () => {
    const { spec } = await load('sign-up');
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe('sign-up');
    expect(spec!.description.length).toBeGreaterThan(80);
    expect(spec!.version).toBe('1.0.0');
    expect(spec!.triggers).toContain('sign up');
    expect(spec!.triggers?.some(t => /[؀-ۿ]/.test(t))).toBe(true);
    expect(spec!.slashAliases ?? []).toEqual([]); // no slash command (it would need the slash catalog)
    const b = spec!.body;
    for (const s of ['vault_generate_and_fill', 'confirm_ref', 'mail_list', 'mail_read', 'browser_navigate', 'browser_request_human', '[CHALLENGE_UNSOLVED]']) {
      expect(b, s).toContain(s);
    }
    expect(b).toMatch(/asks the human in every approval mode, auto included/);
    expect(b).toMatch(/never see, type or say the password/i);
    expect(b).toMatch(/Never solve or bypass a CAPTCHA/);
  });

  it('manage-site: parses, logs in from the vault, destructive changes need the user, hand-off', async () => {
    const { spec } = await load('manage-site');
    expect(spec).not.toBeNull();
    expect(spec!.description.length).toBeGreaterThan(80);
    expect(spec!.triggers?.some(t => /[؀-ۿ]/.test(t))).toBe(true);
    expect(spec!.slashAliases ?? []).toEqual([]);
    const b = spec!.body;
    for (const s of ['browser_login', 'vault_list', 'browser_fill_secret', 'browser_request_human', 'Sentinel']) expect(b, s).toContain(s);
    expect(b).toMatch(/Destructive or account-level changes/);
    expect(b).toMatch(/never ask\s+for a password in the chat/);
  });

  it('skills stay small (they are injected into the prompt when they trigger)', async () => {
    for (const n of ['sign-up', 'manage-site']) {
      const { raw } = await load(n);
      expect(raw.length, n).toBeLessThan(4000);
    }
  });
});
